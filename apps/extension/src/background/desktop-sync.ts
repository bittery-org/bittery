/**
 * Desktop Sync Service
 *
 * Polls desktop app for lock status and subscribes to SSE events
 * for real-time lock/unlock synchronization.
 */

import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { _lockInternal, setDesktopModeSentinel } from "./session-manager";

const DESKTOP_BASE_URL = "http://localhost:48765";
const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const STATUS_TIMEOUT_MS = 2000; // 2 second timeout for status checks
const DESKTOP_MODE_RECOVERY_WINDOW_MS = 60000; // 1 minute window to recover desktop mode after restart

// Storage keys for persistent state
const STORAGE_KEY_DESKTOP_MODE = "desktop_mode_state";

interface DesktopModeState {
	lastConnectedAt: number;
	activeAccount: string | null;
}

export interface DesktopStatus {
	available: boolean;
	locked: boolean;
	unlockedAccounts: string[];
	timestamp: number;
	autolockTimeoutMs: number;
}

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
	private eventSource: EventSource | null = null;

	/**
	 * Initialize the desktop sync service
	 */
	async initialize(): Promise<void> {
		console.log("[Desktop Sync] Initializing");

		// Check if desktop is available first
		const status = await this.checkDesktopStatus();

		// If desktop is available, sync accounts from desktop (even if locked)
		if (status?.available) {
			await this.syncAccountsFromDesktop();

			// If desktop is unlocked, set sentinel MUK to mark extension as unlocked
			if (!status.locked && status.unlockedAccounts.length > 0) {
				console.log("[Desktop Sync] Desktop is unlocked, setting sentinel MUK");
				setDesktopModeSentinel();
				await this.saveDesktopModeState();
			}
		}

		// Check if we were previously in desktop mode (service worker restart recovery)
		const previousState = await this.loadDesktopModeState();
		const now = Date.now();

		if (
			previousState &&
			now - previousState.lastConnectedAt < DESKTOP_MODE_RECOVERY_WINDOW_MS
		) {
			console.log(
				"[Desktop Sync] Recovering from service worker restart (desktop mode was active)",
			);
			console.log(
				`[Desktop Sync] Last connected ${Math.round((now - previousState.lastConnectedAt) / 1000)}s ago`,
			);

			// Attempt to reconnect to desktop
			const status = await this.checkDesktopStatus();

			if (status?.available && !status.locked) {
				console.log(
					"[Desktop Sync] Desktop still available and unlocked, recovering desktop mode",
				);

				// Set sentinel MUK to mark as "unlocked via desktop"
				setDesktopModeSentinel();

				// Restore active account if available
				if (previousState.activeAccount) {
					try {
						// Check if active account is "all" or a specific email
						if (previousState.activeAccount === "all") {
							await storage.setActiveAccount({ type: "all" });
							console.log("[Desktop Sync] Restored active account: all");
						} else {
							await storage.setActiveAccount({
								type: "single",
								email: previousState.activeAccount,
							});
							console.log(
								`[Desktop Sync] Restored active account: ${previousState.activeAccount}`,
							);
						}
					} catch (error) {
						console.error(
							"[Desktop Sync] Failed to restore active account:",
							error,
						);
					}
				}

				// Subscribe to SSE for real-time events
				await this.subscribeToSSE();

				console.log("[Desktop Sync] Desktop mode recovered successfully");
			} else {
				console.log(
					"[Desktop Sync] Desktop not available or locked, cannot recover desktop mode",
				);
				await this.clearDesktopModeState();
			}
		}

		// Check desktop status immediately (fresh check if not recovering)
		if (
			!previousState ||
			now - previousState.lastConnectedAt >= DESKTOP_MODE_RECOVERY_WINDOW_MS
		) {
			const status = await this.checkDesktopStatus();

			if (status?.available) {
				console.log("[Desktop Sync] Desktop available, subscribing to SSE");

				// If desktop is locked, ensure extension is locked
				if (status.locked) {
					console.log("[Desktop Sync] Desktop is locked, locking extension");
					await _lockInternal();
				} else if (status.unlockedAccounts.length > 0) {
					// If desktop is unlocked, try to auto-unlock extension
					console.log(
						`[Desktop Sync] Desktop is unlocked for accounts: ${status.unlockedAccounts.join(", ")}, attempting auto-unlock`,
					);
					await this.handleUnlockEvent({
						accounts: status.unlockedAccounts,
						timestamp: status.timestamp,
					});
				}

				// Subscribe to SSE for real-time events
				await this.subscribeToSSE();
			} else {
				console.log(
					"[Desktop Sync] Desktop not available, operating independently",
				);
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
		console.log("[Desktop Sync] Syncing accounts from desktop");

		try {
			const accountsData = await desktopClient.getAccounts();
			if (!accountsData || !accountsData.accounts) {
				console.log("[Desktop Sync] No accounts data from desktop");
				return;
			}

			// Get current extension accounts
			const currentAccounts = await storage.getAccountsList();
			const currentEmails = new Set(
				currentAccounts.map((a) => a.email.toLowerCase()),
			);

			// Add any accounts from desktop that aren't in extension
			let addedCount = 0;
			for (const desktopAccount of accountsData.accounts) {
				const email = desktopAccount.email.toLowerCase();
				if (!currentEmails.has(email)) {
					await storage.addAccount({
						email: desktopAccount.email,
						userId: desktopAccount.userId,
						name: desktopAccount.name,
						secretKeyHint: desktopAccount.secretKeyHint,
						teamName: desktopAccount.teamName,
						addedAt: desktopAccount.addedAt ?? Date.now(),
						lastActiveAt: desktopAccount.lastActiveAt ?? Date.now(),
						biometricEnabled: desktopAccount.biometricEnabled ?? false,
					});
					addedCount++;
					console.log(
						`[Desktop Sync] Added account from desktop: ${desktopAccount.email}`,
					);
				}
			}

			// Update active account if desktop has one set
			if (accountsData.active_account) {
				// Check if active account is "all" or a specific email
				if (accountsData.active_account === "all") {
					await storage.setActiveAccount({ type: "all" });
					console.log("[Desktop Sync] Set active account: all");
				} else {
					await storage.setActiveAccount({
						type: "single",
						email: accountsData.active_account,
					});
					console.log(
						`[Desktop Sync] Set active account: ${accountsData.active_account}`,
					);
				}
			}

			if (addedCount > 0) {
				console.log(
					`[Desktop Sync] Synced ${addedCount} account(s) from desktop`,
				);
			} else {
				console.log("[Desktop Sync] No new accounts to sync");
			}
		} catch (error) {
			console.error(
				"[Desktop Sync] Failed to sync accounts from desktop:",
				error,
			);
		}
	}

	/**
	 * Check desktop status via HTTP
	 */
	async checkDesktopStatus(): Promise<DesktopStatus | null> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);

			const response = await fetch(
				`${DESKTOP_BASE_URL}/native-bridge/lock-status`,
				{
					method: "GET",
					signal: controller.signal,
				},
			);

			clearTimeout(timeoutId);

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const data = await response.json();

			const status: DesktopStatus = {
				available: true,
				locked: data.locked ?? true,
				unlockedAccounts: data.unlocked_accounts ?? [],
				timestamp: data.timestamp ?? Date.now(),
				autolockTimeoutMs: data.autolock_timeout_ms ?? -1,
			};

			this.lastDesktopStatus = status;
			this.desktopAvailable = true;

			return status;
		} catch {
			// Desktop not available or unreachable
			this.desktopAvailable = false;
			this.lastDesktopStatus = null;
			return null;
		}
	}

	/**
	 * Subscribe to SSE for real-time lock/unlock events
	 */
	async subscribeToSSE(): Promise<void> {
		// Close existing connection
		if (this.eventSource) {
			console.log("[Desktop Sync] Closing existing SSE connection");
			this.eventSource.close();
		}

		try {
			console.log(
				"[Desktop Sync] Creating new SSE connection to",
				`${DESKTOP_BASE_URL}/native-bridge/lock-events`,
			);
			this.eventSource = new EventSource(
				`${DESKTOP_BASE_URL}/native-bridge/lock-events`,
			);

			this.eventSource.addEventListener("connected", (event) => {
				console.log("[Desktop Sync] ✅ SSE connected successfully", event.data);
				// Save desktop mode state when successfully connected
				this.saveDesktopModeState();
			});

			this.eventSource.addEventListener("open", () => {
				console.log("[Desktop Sync] ✅ SSE connection opened");
			});

			this.eventSource.addEventListener("lock", (event) => {
				console.log("[Desktop Sync] 📨 SSE lock event received", event.data);
				try {
					const data: LockEvent = JSON.parse(event.data);
					console.log("[Desktop Sync] Parsed lock event:", data);
					this.handleLockEvent(data).catch((error) => {
						console.error("[Desktop Sync] handleLockEvent failed:", error);
					});
				} catch (error) {
					console.error("[Desktop Sync] Failed to parse lock event:", error);
				}
			});

			this.eventSource.addEventListener("unlock", (event) => {
				console.log("[Desktop Sync] 📨 SSE unlock event received", event.data);
				try {
					const data: UnlockEvent = JSON.parse(event.data);
					console.log("[Desktop Sync] Parsed unlock event:", data);
					this.handleUnlockEvent(data).catch((error) => {
						console.error("[Desktop Sync] handleUnlockEvent failed:", error);
					});
				} catch (error) {
					console.error("[Desktop Sync] Failed to parse unlock event:", error);
				}
			});

			this.eventSource.addEventListener("desktop_close", (event) => {
				console.log("[Desktop Sync] 📨 SSE desktop_close event received");
				const data: DesktopCloseEvent = JSON.parse(event.data);
				this.handleDesktopCloseEvent(data);
			});

			this.eventSource.addEventListener("active_account_changed", (event) => {
				console.log(
					"[Desktop Sync] 📨 SSE active_account_changed event received",
				);
				const data: ActiveAccountChangedEvent = JSON.parse(event.data);
				this.handleActiveAccountChanged(data);
			});

			this.eventSource.onerror = (error) => {
				console.error("[Desktop Sync] ❌ SSE error:", error);
				console.log(
					"[Desktop Sync] SSE readyState:",
					this.eventSource?.readyState,
				);
				this.eventSource?.close();
				this.eventSource = null;

				// Don't set desktopAvailable to false - we'll check via polling
				// Fallback to polling
				console.log("[Desktop Sync] SSE failed, relying on polling");
			};
		} catch (error) {
			console.error("[Desktop Sync] Failed to subscribe to SSE:", error);
			this.desktopAvailable = false;
		}
	}

	/**
	 * Handle lock event from desktop
	 */
	async handleLockEvent(event: LockEvent): Promise<void> {
		console.log("[Desktop Sync] 🔒 handleLockEvent CALLED", event);
		console.log(
			`[Desktop Sync] Desktop locked (${event.reason}), locking extension`,
		);

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
		} catch (error) {
			// Ignore if no listeners
			console.log("[Desktop Sync] No UI listeners for DESKTOP_LOCKED event");
		}

		// Show notification (if API is available)
		try {
			if (typeof chrome !== "undefined" && chrome?.notifications?.create) {
				await chrome.notifications.create({
					type: "basic",
					iconUrl: "icon128.png",
					title: "Vault Locked",
					message:
						event.reason === "autolock"
							? "Desktop auto-locked"
							: "Desktop locked",
				});
			}
		} catch (error) {
			console.error("[Desktop Sync] Failed to show notification:", error);
		}
	}

	/**
	 * Handle unlock event from desktop (set desktop mode and notify)
	 */
	async handleUnlockEvent(event: UnlockEvent): Promise<void> {
		console.log("[Desktop Sync] 🔓 handleUnlockEvent CALLED", event);
		console.log(
			`[Desktop Sync] Desktop unlocked for accounts: ${event.accounts.join(", ")}`,
		);

		// Clear desktop client cache (will fetch fresh session data on next request)
		desktopClient.clearCache();

		if (event.accounts.length === 0) {
			console.warn("[Desktop Sync] No accounts unlocked");
			return;
		}

		// In desktop mode, just set the sentinel MUK to mark extension as unlocked
		setDesktopModeSentinel();
		console.log(
			"[Desktop Sync] Set desktop mode sentinel (extension unlocked)",
		);

		// Notify popup to navigate to vault immediately
		try {
			chrome.runtime.sendMessage({
				type: "DESKTOP_UNLOCKED",
				accounts: event.accounts,
			});
			console.log("[Desktop Sync] Sent DESKTOP_UNLOCKED message to popup");
		} catch (error) {
			// Ignore if no listeners
			console.log("[Desktop Sync] No UI listeners for DESKTOP_UNLOCKED event");
		}

		// Show notification
		try {
			await chrome.notifications.create({
				type: "basic",
				iconUrl: "icon128.png",
				title: "Vault Unlocked",
				message:
					event.accounts.length === 1
						? "Unlocked with desktop app"
						: `${event.accounts.length} accounts unlocked with desktop app`,
			});
		} catch (error) {
			console.error("[Desktop Sync] Failed to show notification:", error);
		}
	}

	/**
	 * Handle desktop close event
	 */
	async handleDesktopCloseEvent(_event: DesktopCloseEvent): Promise<void> {
		console.log("[Desktop Sync] Desktop closed, locking extension");

		// Clear desktop client cache
		desktopClient.clearCache();

		// Lock extension immediately (bypass desktop check)
		await _lockInternal();

		// Mark desktop as unavailable
		this.desktopAvailable = false;
		this.lastDesktopStatus = null;

		// Clear desktop mode state
		await this.clearDesktopModeState();

		// Close SSE connection
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
	}

	/**
	 * Handle active account changed event from desktop
	 */
	async handleActiveAccountChanged(
		event: ActiveAccountChangedEvent,
	): Promise<void> {
		console.log(
			`[Desktop Sync] Active account changed in desktop to: ${event.email}`,
		);

		// Clear desktop client cache for the old account
		desktopClient.clearCache();

		// Update active account in extension storage to match desktop
		try {
			await storage.setActiveAccount({ type: "single", email: event.email });
			console.log(
				`[Desktop Sync] Updated extension active account to: ${event.email}`,
			);
		} catch (error) {
			console.error("[Desktop Sync] Failed to update active account:", error);
		}
	}

	/**
	 * Start polling for desktop status
	 */
	startPolling(): void {
		if (this.pollInterval) return;

		console.log("[Desktop Sync] Starting status polling");
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
					console.log("[Desktop Sync] Polling detected lock event");
					await this.handleLockEvent({
						reason: "poll-detected",
						timestamp: newStatus.timestamp,
					});
				} else if (wasLocked && !isLocked) {
					// Desktop just unlocked
					console.log("[Desktop Sync] Polling detected unlock event");
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
					console.log(
						"[Desktop Sync] Polling detected unlocked accounts changed",
					);
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
			console.log("[Desktop Sync] Stopped status polling");
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

		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
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
			const state: DesktopModeState = {
				lastConnectedAt: Date.now(),
				activeAccount:
					activeAccount?.type === "single"
						? activeAccount.email
						: activeAccount?.type === "all"
							? "all"
							: null,
			};
			await chrome.storage.local.set({ [STORAGE_KEY_DESKTOP_MODE]: state });
			console.log("[Desktop Sync] Saved desktop mode state");
		} catch (error) {
			console.error("[Desktop Sync] Failed to save desktop mode state:", error);
		}
	}

	/**
	 * Load desktop mode state from persistent storage
	 */
	private async loadDesktopModeState(): Promise<DesktopModeState | null> {
		try {
			const result = await chrome.storage.local.get(STORAGE_KEY_DESKTOP_MODE);
			const state = result[STORAGE_KEY_DESKTOP_MODE] as
				| DesktopModeState
				| undefined;
			if (state) {
				console.log("[Desktop Sync] Loaded desktop mode state:", state);
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
			console.log("[Desktop Sync] Cleared desktop mode state");
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
