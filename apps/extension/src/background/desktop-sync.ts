/**
 * Desktop Sync Service
 *
 * Polls desktop app for lock status and subscribes to desktop events
 * for real-time lock/unlock synchronization.
 */

import { storage } from "../lib/storage";
import { desktopClient, type DesktopStatus } from "./desktop-client";
import type { DesktopEventPayload } from "./desktop-protocol";
import {
	type DesktopModeStateSnapshot,
	evaluateDesktopRecoveryDecision,
} from "./services/desktop-recovery";
import { _lockInternal, setDesktopModeSentinel } from "./session-manager";

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
	email: string;
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

			// If desktop is unlocked, set sentinel MUK to mark extension as unlocked
			if (!status.locked && status.unlockedAccounts.length > 0) {
				setDesktopModeSentinel();
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
				// Set sentinel MUK to mark as "unlocked via desktop"
				setDesktopModeSentinel();

				// Restore active account if available
				if (previousState.activeAccount) {
					try {
						// Check if active account is "all" or a specific email
						if (previousState.activeAccount === "all") {
							await storage.setActiveAccount({ type: "all" });
						} else {
							await storage.setActiveAccount({
								type: "single",
								email: previousState.activeAccount,
							});
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
				// If desktop is locked, ensure extension is locked
				if (status.locked) {
					await _lockInternal();
				} else if (status.unlockedAccounts.length > 0) {
					// If desktop is unlocked, try to auto-unlock extension
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
				const email = desktopAccount.email.toLowerCase();
				const existingAccount = currentAccounts.find(
					(a) => a.email.toLowerCase() === email,
				);

				if (!existingAccount) {
					// Add new account
					await storage.addAccount({
						email: desktopAccount.email,
						userId: desktopAccount.userId,
						name: desktopAccount.name,
						secretKeyHint: desktopAccount.secretKeyHint,
						teamName: desktopAccount.teamName,
						teamAvatarUrl: desktopAccount.teamAvatarUrl,
						addedAt: desktopAccount.addedAt ?? Date.now(),
						lastActiveAt: desktopAccount.lastActiveAt ?? Date.now(),
						biometricEnabled: desktopAccount.biometricEnabled ?? false,
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
				// Check if active account is "all" or a specific email
				if (accountsData.activeAccount === "all") {
					await storage.setActiveAccount({ type: "all" });
				} else {
					await storage.setActiveAccount({
						type: "single",
						email: accountsData.activeAccount,
					});
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
	 * Check desktop status
	 */
	async checkDesktopStatus(): Promise<DesktopStatus | null> {
		const data = await desktopClient.getLockStatus();
		if (!data) {
			this.desktopAvailable = false;
			this.lastDesktopStatus = null;
			return null;
		}

		this.lastDesktopStatus = data;
		this.desktopAvailable = true;
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
		}
	}

	/**
	 * Handle lock event from desktop
	 */
	async handleLockEvent(event: LockEvent): Promise<void> {
		// Clear desktop client cache
		desktopClient.clearCache();

		// Immediately lock extension (bypass desktop check)
		await _lockInternal();

		// Notify UI to clear cache and refresh
		try {
			chrome.runtime.sendMessage({
				type: "DESKTOP_LOCKED",
				reason: event.reason,
			});
		} catch (_error) {
			// Ignore if no listeners
		}
	}

	/**
	 * Handle unlock event from desktop (set desktop mode and notify)
	 */
	async handleUnlockEvent(event: UnlockEvent): Promise<void> {
		// Clear desktop client cache (will fetch fresh session data on next request)
		desktopClient.clearCache();

		if (event.accounts.length === 0) {
			console.warn("[Desktop Sync] No accounts unlocked");
			return;
		}

		// In desktop mode, just set the sentinel MUK to mark extension as unlocked
		setDesktopModeSentinel();

		// Notify popup to navigate to vault immediately
		try {
			chrome.runtime.sendMessage({
				type: "DESKTOP_UNLOCKED",
				accounts: event.accounts,
			});
		} catch (_error) {
			// Ignore if no listeners
		}
	}

	/**
	 * Handle desktop close event
	 */
	async handleDesktopCloseEvent(_event: DesktopCloseEvent): Promise<void> {
		// Clear desktop client cache
		desktopClient.clearCache();

		// Lock extension immediately (bypass desktop check)
		await _lockInternal();

		// Mark desktop as unavailable
		this.desktopAvailable = false;
		this.lastDesktopStatus = null;

		// Clear desktop mode state
		await this.clearDesktopModeState();

		if (this.unsubscribeDesktopEvents) {
			this.unsubscribeDesktopEvents();
			this.unsubscribeDesktopEvents = null;
		}
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
			await storage.setActiveAccount({ type: "single", email: event.email });
		} catch (error) {
			console.error("[Desktop Sync] Failed to update active account:", error);
		}
	}

	/**
	 * Start polling for desktop status
	 */
	startPolling(): void {
		if (this.pollInterval) return;

		this.pollInterval = setInterval(async () => {
			const previousStatus = this.lastDesktopStatus;
			const newStatus = await this.checkDesktopStatus();

			// Detect state changes and trigger event handlers
			if (previousStatus && newStatus) {
				// Check if lock state changed
				const wasLocked = previousStatus.locked;
				const isLocked = newStatus.locked;

				if (!wasLocked && isLocked) {
					// Desktop just locked
					await this.handleLockEvent({
						reason: "poll-detected",
						timestamp: newStatus.timestamp,
					});
				} else if (wasLocked && !isLocked) {
					// Desktop just unlocked
					await this.handleUnlockEvent({
						accounts: newStatus.unlockedAccounts,
						timestamp: newStatus.timestamp,
					});
				}

				// Check if unlocked accounts changed (account switch while unlocked)
				if (
					!isLocked &&
					JSON.stringify(previousStatus.unlockedAccounts) !==
						JSON.stringify(newStatus.unlockedAccounts)
				) {
					// Could trigger account sync here if needed
				}
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
	 * Get desktop autolock timeout (to inherit in extension)
	 */
	getDesktopTimeout(): number | null {
		if (!this.desktopAvailable || !this.lastDesktopStatus) {
			return null;
		}

		return this.lastDesktopStatus.autolockTimeoutMs;
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
				activeAccount:
					activeAccount?.type === "single"
						? activeAccount.email
						: activeAccount?.type === "all"
							? "all"
							: null,
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
