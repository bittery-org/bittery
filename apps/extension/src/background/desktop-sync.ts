/**
 * Desktop Sync Service
 *
 * Polls desktop app for lock status and subscribes to desktop events
 * for real-time lock/unlock synchronization.
 */

import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { AccountMetadata } from "@bittery/storage";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import type {
	DesktopAccountEntry,
	DesktopEventOf,
	DesktopEventPayload,
	DesktopStatus,
} from "./desktop-protocol";
import { emitBackgroundEvent } from "./events";
import {
	type DesktopModeStateSnapshot,
	evaluateDesktopRecoveryDecision,
} from "./services/desktop-recovery";
import { vaultSession, vaultSessionPorts } from "./vault-session";

const DEFAULT_SERVER_URL = "http://localhost:3000";

/**
 * Project a desktop-published account onto the extension's own `AccountMetadata`.
 *
 * `DESKTOP_ACCOUNTS` publishes identity and display metadata and nothing else.
 * It has never carried `serverUrl` — that is per-install, not per-account, and
 * `AccountStore` deliberately keeps it out of the native-host view — and it has
 * never carried `insecureTransportConfirmed`. Both are required here, so both
 * are resolved on this side: the extension's own server URL, and no recorded
 * consent for plain HTTP, which is the safe answer because consent given on the
 * desktop is not consent given here.
 *
 * Until the protocol types were generated this function's predecessor read both
 * fields straight off the response, where they were declared but never sent, and
 * every desktop-synced account was written with `serverUrl: undefined`.
 */
export function desktopAccountToMetadata(
	account: DesktopAccountEntry,
	serverUrl: string,
): AccountMetadata {
	return {
		accountId: account.accountId,
		email: account.email,
		userId: account.userId,
		name: account.name,
		serverUrl,
		secretKeyHint: account.secretKeyHint,
		teamName: account.teamName,
		teamAvatarUrl: account.teamAvatarUrl,
		addedAt: account.addedAt,
		lastActiveAt: account.lastActiveAt,
		biometricEnabled: account.biometricEnabled,
		insecureTransportConfirmed: false,
	};
}

const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const DESKTOP_MODE_RECOVERY_WINDOW_MS = 60000; // 1 minute window to recover desktop mode after restart

// Storage keys for persistent state
const STORAGE_KEY_DESKTOP_MODE = "desktop_mode_state";

// The desktop owns these shapes; ts-rs generates them and this side only names
// them (ADR 0012). They were hand-copies until the protocol became generated.
export type LockEvent = DesktopEventOf<"lock">;
export type UnlockEvent = DesktopEventOf<"unlock">;
export type DesktopCloseEvent = DesktopEventOf<"desktop_close">;
export type ActiveAccountChangedEvent =
	DesktopEventOf<"active_account_changed">;
export type ThemeChangedEvent = DesktopEventOf<"theme_changed">;

export class DesktopSyncService {
	constructor(private readonly accountManager: AccountSessionManager) {}
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
						const account = accounts.find(
							(item) => item.accountId === previousState.activeAccount,
						);
						if (account) {
							await storage.setActiveAccount(account.accountId);
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
			const serverUrl = (await storage.getServerUrl()) ?? DEFAULT_SERVER_URL;

			// Add or update accounts from desktop
			for (const desktopAccount of accountsData.accounts) {
				const desktopAccountId = desktopAccount.accountId;
				const existingAccount = currentAccounts.find(
					(a) => a.accountId === desktopAccountId,
				);

				if (!existingAccount) {
					await storage.addAccount(
						desktopAccountToMetadata(desktopAccount, serverUrl),
					);
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
				const active = refreshedAccounts.find(
					(item) => item.accountId === accountsData.activeAccount,
				);
				if (active) {
					await storage.setActiveAccount(active.accountId);
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

		void emitBackgroundEvent({ type: "THEME_CHANGED", theme: event.theme });
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
			await this.accountManager.refresh();
		} catch (error) {
			console.error("[Desktop Sync] Failed to update active account:", error);
			return;
		}

		void emitBackgroundEvent({
			type: "ACTIVE_ACCOUNT_CHANGED",
			accountId: event.accountId,
		});
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

let configuredDesktopSync: DesktopSyncService | undefined;

/** Register the worker-owned desktop service before background handlers run. */
export function configureDesktopSync(service: DesktopSyncService): void {
	configuredDesktopSync = service;
}

export function getDesktopSync(): DesktopSyncService {
	if (!configuredDesktopSync) {
		throw new Error("Desktop sync is not configured");
	}
	return configuredDesktopSync;
}
