/**
 * Desktop Sync Service
 *
 * Polls desktop app for lock status and subscribes to desktop events
 * for real-time lock/unlock synchronization.
 */

import {
	getAccountSessionManager,
	peekAccountSessionManager,
} from "@bittery/core/services/account-session-manager";
import { selectActiveAccountAfterUnlock } from "@bittery/core/services/select-active-account";
import { itemCache, storage } from "../lib/storage";
import { type DesktopStatus, desktopClient } from "./desktop-client";
import type { DesktopEventPayload } from "./desktop-protocol";
import {
	type DesktopModeStateSnapshot,
	evaluateDesktopRecoveryDecision,
} from "./services/desktop-recovery";
import { vaultSession, vaultSessionPorts } from "./vault-session";

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const DESKTOP_MODE_RECOVERY_WINDOW_MS = 60000; // 1 minute window to recover desktop mode after restart

// Storage keys for persistent state
const STORAGE_KEY_DESKTOP_MODE = "desktop_mode_state";

export interface LockEvent {
	reason: string;
	timestamp: number;
}

export interface UnlockEvent {
	accounts: string[];
	timestamp: number;
}

export interface DesktopCloseEvent {
	timestamp: number;
}

export interface ActiveAccountChangedEvent {
	accountId: string;
	timestamp: number;
}

export interface ThemeChangedEvent {
	theme: "light" | "dark" | "system";
	timestamp: number;
}

class DesktopSyncService {
	private lastDesktopStatus: DesktopStatus | null = null;
	private desktopAvailable = false;
	private pollInterval: ReturnType<typeof setInterval> | null = null;
	private unsubscribeDesktopEvents: (() => void) | null = null;

	/**
	 * Initialize the desktop sync service
	 *
	 * Lifecycle phases:
	 * 1) Seed local account/cache state from desktop availability.
	 * 2) Attempt restart recovery if desktop mode was recently active.
	 * 3) Fall back to a fresh status check and subscribe to desktop events.
	 * 4) Keep polling as a safety net if event delivery drops.
	 */
	async initialize(): Promise<void> {
		// Check if desktop is available first
		const status = await this.checkDesktopStatus();

		// If desktop is available, sync accounts from desktop (even if locked)
		if (status?.available) {
			await this.syncAccountsFromDesktop();

			if (!status.locked && status.unlockedAccounts.length > 0) {
				await vaultSession.dispatch({
					type: "DESKTOP_UNLOCK_PUSHED",
					accountIds: status.unlockedAccounts,
					at: Date.now(),
				});
				await this.saveDesktopModeState();
			}
		}

		// Check if we were previously in desktop mode (service worker restart recovery).
		const previousState = await this.loadDesktopModeState();
		const now = Date.now();
		const recoveryDecision = evaluateDesktopRecoveryDecision(
			previousState,
			now,
			DESKTOP_MODE_RECOVERY_WINDOW_MS,
		);
		if (recoveryDecision.shouldAttemptRecovery && previousState) {
			// Attempt to reconnect to desktop
			const status = await this.checkDesktopStatus();

			if (status?.available && !status.locked) {
				await vaultSession.dispatch({
					type: "DESKTOP_UNLOCK_PUSHED",
					accountIds: status.unlockedAccounts,
					at: Date.now(),
				});

				// Restore active account if available
				if (previousState.activeAccount) {
					try {
						const accounts = await storage.getAccountsList();
						// All-accounts mode was removed; collapse a legacy "all" pointer
						// to the single account the user was last on.
						if (previousState.activeAccount === "all") {
							const previousActive = await storage.getActiveAccount();
							const unlocked = await storage.getUnlockedAccounts();
							const accountId = selectActiveAccountAfterUnlock({
								previousActive,
								unlockedAccountIds: unlocked,
								accounts,
							});
							if (accountId) {
								await storage.setActiveAccount(accountId);
							}
						} else {
							const account = accounts.find(
								(item) => item.accountId === previousState.activeAccount,
							);
							if (account) {
								await storage.setActiveAccount(account.accountId);
							}
						}
					} catch (error) {
						console.error(
							"[Desktop Sync] Failed to restore active account:",
							error,
						);
					}
				}

				await this.subscribeToDesktopEvents();
			} else {
				await this.clearDesktopModeState();
			}
		}

		// Check desktop status immediately (fresh check if not recovering)
		if (!recoveryDecision.shouldAttemptRecovery) {
			const status = await this.checkDesktopStatus();

			if (status?.available) {
				// A locked desktop already locked this side: `checkDesktopStatus`
				// dispatched `DESKTOP_OBSERVED` and the reducer derives that edge.
				if (!status.locked && status.unlockedAccounts.length > 0) {
					await this.handleUnlockEvent({
						accounts: status.unlockedAccounts,
						timestamp: status.timestamp,
					});
				}

				await this.subscribeToDesktopEvents();
			}
		}

		// Start polling as backup
		this.startPolling();
	}

	/**
	 * Sync account list from desktop to extension storage
	 * This ensures extension has the same accounts as desktop, even when locked
	 */
	async syncAccountsFromDesktop(): Promise<void> {
		try {
			const accountsData = await desktopClient.getAccounts();
			if (!accountsData || !accountsData.accounts) {
				return;
			}

			// Get current extension accounts
			const currentAccounts = await storage.getAccountsList();

			// Add or update accounts from desktop
			for (const desktopAccount of accountsData.accounts) {
				const desktopAccountId = desktopAccount.accountId;
				const existingAccount = currentAccounts.find(
					(a) => a.accountId === desktopAccountId,
				);

				if (!existingAccount) {
					await storage.addAccount({
						accountId: desktopAccountId,
						email: desktopAccount.email,
						userId: desktopAccount.userId,
						name: desktopAccount.name,
						secretKeyHint: desktopAccount.secretKeyHint,
						teamName: desktopAccount.teamName,
						teamAvatarUrl: desktopAccount.teamAvatarUrl,
						addedAt: desktopAccount.addedAt,
						lastActiveAt: desktopAccount.lastActiveAt,
						biometricEnabled: desktopAccount.biometricEnabled,
					});
				} else {
					// Update existing account with latest data from desktop
					// This ensures teamAvatarUrl and other fields stay in sync
					const needsUpdate =
						existingAccount.teamAvatarUrl !== desktopAccount.teamAvatarUrl ||
						existingAccount.teamName !== desktopAccount.teamName;

					if (needsUpdate) {
						await storage.addAccount({
							...existingAccount,
							teamName: desktopAccount.teamName,
							teamAvatarUrl: desktopAccount.teamAvatarUrl,
						});
					}
				}
			}

			// Update active account if desktop has one set
			if (accountsData.activeAccount) {
				const refreshedAccounts = await storage.getAccountsList();
				// All-accounts mode was removed; collapse a legacy "all" pointer to
				// the single account the user was last on.
				if (accountsData.activeAccount === "all") {
					const previousActive = await storage.getActiveAccount();
					const unlocked = await storage.getUnlockedAccounts();
					const accountId = selectActiveAccountAfterUnlock({
						previousActive,
						unlockedAccountIds: unlocked,
						accounts: refreshedAccounts,
					});
					if (accountId) {
						await storage.setActiveAccount(accountId);
					}
				} else {
					const active = refreshedAccounts.find(
						(item) => item.accountId === accountsData.activeAccount,
					);
					if (active) {
						await storage.setActiveAccount(active.accountId);
					}
				}
			}
		} catch (error) {
			console.error(
				"[Desktop Sync] Failed to sync accounts from desktop:",
				error,
			);
		}
	}

	/**
	 * Check desktop status.
	 *
	 * `desktopAvailable` is reachability — the native host answers
	 * `{available:false, locked:true}` when it cannot reach the app — and every
	 * read feeds the reducer, which derives the lock and disconnect edges itself.
	 */
	async checkDesktopStatus(): Promise<DesktopStatus | null> {
		const previousLocked = this.lastDesktopStatus?.locked ?? null;
		const data = await desktopClient.getLockStatus();

		this.lastDesktopStatus = data;
		this.desktopAvailable = data !== null;

		// Cached desktop tokens and items belong to the previous lock state.
		if ((data?.locked ?? null) !== previousLocked) {
			desktopClient.clearCache();
		}

		await vaultSession.dispatch({
			type: "DESKTOP_OBSERVED",
			status: vaultSessionPorts.desktop.readCached(),
			at: Date.now(),
		});

		return data;
	}

	/**
	 * Subscribe to desktop events over native messaging
	 */
	async subscribeToDesktopEvents(): Promise<void> {
		if (this.unsubscribeDesktopEvents) {
			this.unsubscribeDesktopEvents();
		}

		this.unsubscribeDesktopEvents = desktopClient.subscribeToDesktopEvents(
			(event) => {
				void this.handleDesktopEvent(event);
			},
		);
	}

	private async handleDesktopEvent(event: DesktopEventPayload): Promise<void> {
		await this.saveDesktopModeState();

		if (event.event === "lock") {
			await this.handleLockEvent(event.payload);
			return;
		}

		if (event.event === "unlock") {
			await this.handleUnlockEvent(event.payload);
			return;
		}

		if (event.event === "desktop_close") {
			await this.handleDesktopCloseEvent(event.payload);
			return;
		}

		if (event.event === "active_account_changed") {
			await this.handleActiveAccountChanged(event.payload);
			return;
		}

		if (event.event === "theme_changed") {
			this.handleThemeChanged(event.payload);
		}
	}

	/**
	 * Handle theme changed event from desktop. The desktop app's appearance
	 * setting overrides the extension's local preference while it is running, so
	 * forward the new value to the popup for immediate application.
	 */
	handleThemeChanged(event: ThemeChangedEvent): void {
		// Keep the cached status in sync so pollers/readers see the new theme.
		if (this.lastDesktopStatus) {
			this.lastDesktopStatus = {
				...this.lastDesktopStatus,
				theme: event.theme,
			};
		}

		try {
			chrome.runtime.sendMessage({
				type: "THEME_CHANGED",
				theme: event.theme,
			});
		} catch (_error) {
			// Ignore if no listeners
		}
	}

	/**
	 * Handle lock event from desktop.
	 *
	 * The reducer owns both the lock and the `DESKTOP_LOCKED` push, so the two
	 * can never disagree.
	 */
	async handleLockEvent(event: LockEvent): Promise<void> {
		desktopClient.clearCache();

		await vaultSession.dispatch({
			type: "DESKTOP_LOCK_PUSHED",
			reason: event.reason,
			at: Date.now(),
		});
	}

	/**
	 * Handle unlock event from desktop (hand ownership to the desktop and notify)
	 */
	async handleUnlockEvent(event: UnlockEvent): Promise<void> {
		// Fresh session data is fetched on the next request.
		desktopClient.clearCache();

		if (event.accounts.length === 0) {
			console.warn("[Desktop Sync] No accounts unlocked");
			return;
		}

		await vaultSession.dispatch({
			type: "DESKTOP_UNLOCK_PUSHED",
			accountIds: event.accounts,
			at: Date.now(),
		});
	}

	/**
	 * Handle desktop close event
	 */
	async handleDesktopCloseEvent(_event: DesktopCloseEvent): Promise<void> {
		desktopClient.clearCache();

		// Drop the cached status before dispatching so a concurrent snapshot read
		// cannot re-observe the closed desktop as still connected.
		this.desktopAvailable = false;
		this.lastDesktopStatus = null;

		await vaultSession.dispatch({ type: "DESKTOP_CLOSED", at: Date.now() });

		await this.clearDesktopModeState();

		if (this.unsubscribeDesktopEvents) {
			this.unsubscribeDesktopEvents();
			this.unsubscribeDesktopEvents = null;
		}

		// Polling deliberately keeps running: it is the only path that re-detects a
		// desktop that comes back after the event subscription is torn down.
	}

	/**
	 * Handle active account changed event from desktop
	 */
	async handleActiveAccountChanged(
		event: ActiveAccountChangedEvent,
	): Promise<void> {
		// Clear desktop client cache for the old account
		desktopClient.clearCache();

		// Update active account in extension storage to match desktop
		try {
			await storage.setActiveAccount(event.accountId);
			// The background wires no platform callbacks, so whichever background caller
			// runs first after a service-worker wake may construct the shared manager.
			await (
				peekAccountSessionManager() ??
				getAccountSessionManager({ storage, itemCache })
			).refresh();
		} catch (error) {
			console.error("[Desktop Sync] Failed to update active account:", error);
			return;
		}

		try {
			chrome.runtime.sendMessage({
				type: "ACTIVE_ACCOUNT_CHANGED",
				accountId: event.accountId,
			});
		} catch (_error) {
			// Ignore if no listeners
		}
	}

	/**
	 * Start polling for desktop status
	 */
	startPolling(): void {
		if (this.pollInterval) return;

		this.pollInterval = setInterval(async () => {
			// A missing previous status counts as locked, so a desktop that comes
			// back after the event subscription was torn down is re-detected here.
			const wasLocked = this.lastDesktopStatus?.locked ?? true;
			const status = await this.checkDesktopStatus();

			// `checkDesktopStatus` already reported the observation, and the reducer
			// derives the lock and disconnect edges from it. Only the unlock edge
			// needs an explicit hand-over of ownership to the desktop.
			if (status && wasLocked && !status.locked) {
				await this.handleUnlockEvent({
					accounts: status.unlockedAccounts,
					timestamp: status.timestamp,
				});
			}
		}, POLL_INTERVAL_MS);
	}

	/**
	 * Stop polling
	 */
	stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval);
			this.pollInterval = null;
		}
	}

	/**
	 * Check if desktop is available
	 */
	isDesktopAvailable(): boolean {
		return this.desktopAvailable;
	}

	/**
	 * Get last known desktop status
	 */
	getLastStatus(): DesktopStatus | null {
		return this.lastDesktopStatus;
	}

	/**
	 * Dispose of the service
	 */
	dispose(): void {
		this.stopPolling();

		if (this.unsubscribeDesktopEvents) {
			this.unsubscribeDesktopEvents();
			this.unsubscribeDesktopEvents = null;
		}

		this.desktopAvailable = false;
		this.lastDesktopStatus = null;
	}

	/**
	 * Save desktop mode state to persistent storage
	 */
	private async saveDesktopModeState(): Promise<void> {
		try {
			const activeAccount = await storage.getActiveAccount();
			const state: DesktopModeStateSnapshot = {
				lastConnectedAt: Date.now(),
				activeAccount: activeAccount ?? null,
			};
			await chrome.storage.local.set({ [STORAGE_KEY_DESKTOP_MODE]: state });
		} catch (error) {
			console.error("[Desktop Sync] Failed to save desktop mode state:", error);
		}
	}

	/**
	 * Load desktop mode state from persistent storage
	 */
	private async loadDesktopModeState(): Promise<DesktopModeStateSnapshot | null> {
		try {
			const result = await chrome.storage.local.get(STORAGE_KEY_DESKTOP_MODE);
			const state = result[STORAGE_KEY_DESKTOP_MODE] as
				| DesktopModeStateSnapshot
				| undefined;
			if (state) {
				return state;
			}
			return null;
		} catch (error) {
			console.error("[Desktop Sync] Failed to load desktop mode state:", error);
			return null;
		}
	}

	/**
	 * Clear desktop mode state from persistent storage
	 */
	private async clearDesktopModeState(): Promise<void> {
		try {
			await chrome.storage.local.remove(STORAGE_KEY_DESKTOP_MODE);
		} catch (error) {
			console.error(
				"[Desktop Sync] Failed to clear desktop mode state:",
				error,
			);
		}
	}
}

// Export singleton instance
export const desktopSync = new DesktopSyncService();
