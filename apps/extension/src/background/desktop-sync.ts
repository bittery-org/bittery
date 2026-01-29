/**
 * Desktop Sync Service
 *
 * Polls desktop app for lock status and subscribes to SSE events
 * for real-time lock/unlock synchronization.
 */

import { storage } from "../lib/storage";
import { lock } from "./session-manager";

const DESKTOP_BASE_URL = "http://localhost:48765";
const POLL_INTERVAL_MS = 5000; // Poll every 5 seconds
const STATUS_TIMEOUT_MS = 2000; // 2 second timeout for status checks

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

		// Check desktop status immediately
		const status = await this.checkDesktopStatus();

		if (status && status.available) {
			console.log("[Desktop Sync] Desktop available, subscribing to SSE");

			// If desktop is locked, ensure extension is locked
			if (status.locked) {
				console.log("[Desktop Sync] Desktop is locked, locking extension");
				await lock();
			}

			// Subscribe to SSE for real-time events
			await this.subscribeToSSE();
		} else {
			console.log(
				"[Desktop Sync] Desktop not available, operating independently",
			);
		}

		// Start polling as backup
		this.startPolling();
	}

	/**
	 * Check desktop status via HTTP
	 */
	async checkDesktopStatus(): Promise<DesktopStatus | null> {
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				STATUS_TIMEOUT_MS,
			);

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
		} catch (error) {
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
			this.eventSource.close();
		}

		try {
			this.eventSource = new EventSource(
				`${DESKTOP_BASE_URL}/native-bridge/lock-events`,
			);

			this.eventSource.addEventListener("connected", (event) => {
				console.log("[Desktop Sync] SSE connected", event.data);
			});

			this.eventSource.addEventListener("lock", (event) => {
				const data: LockEvent = JSON.parse(event.data);
				this.handleLockEvent(data);
			});

			this.eventSource.addEventListener("unlock", (event) => {
				const data: UnlockEvent = JSON.parse(event.data);
				this.handleUnlockEvent(data);
			});

			this.eventSource.addEventListener("desktop_close", (event) => {
				const data: DesktopCloseEvent = JSON.parse(event.data);
				this.handleDesktopCloseEvent(data);
			});

			this.eventSource.onerror = (error) => {
				console.error("[Desktop Sync] SSE error:", error);
				this.eventSource?.close();
				this.eventSource = null;
				this.desktopAvailable = false;

				// Fallback to polling
				console.log("[Desktop Sync] Falling back to polling");
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
		console.log(
			`[Desktop Sync] Desktop locked (${event.reason}), locking extension`,
		);

		// Immediately lock extension
		await lock();

		// Show notification
		try {
			await chrome.notifications.create({
				type: "basic",
				iconUrl: "icon128.png",
				title: "Vault Locked",
				message:
					event.reason === "autolock"
						? "Desktop auto-locked"
						: "Desktop locked",
			});
		} catch (error) {
			console.error("[Desktop Sync] Failed to show notification:", error);
		}
	}

	/**
	 * Handle unlock event from desktop (auto-unlock extension)
	 */
	async handleUnlockEvent(event: UnlockEvent): Promise<void> {
		console.log(
			`[Desktop Sync] Desktop unlocked for accounts: ${event.accounts.join(", ")}`,
		);

		// Auto-unlock extension using shared session
		// Note: We'll use the first account for now (single-account extension)
		if (event.accounts.length === 0) {
			console.warn("[Desktop Sync] No accounts unlocked");
			return;
		}

		const email = event.accounts[0];

		// Check if this account has stored session
		const hasSession = await storage.isSessionValid(email);

		if (hasSession) {
			// Restore session from encrypted storage
			try {
				const restored = await storage.tryRestoreSession(false, email);
				if (restored) {
					console.log(`[Desktop Sync] Extension auto-unlocked for ${email}`);

					// Show notification
					try {
						await chrome.notifications.create({
							type: "basic",
							iconUrl: "icon128.png",
							title: "Vault Unlocked",
							message: "Unlocked with desktop app",
						});
					} catch (error) {
						console.error(
							"[Desktop Sync] Failed to show notification:",
							error,
						);
					}
				} else {
					console.warn(
						"[Desktop Sync] Failed to restore session, session may be expired",
					);
				}
			} catch (error) {
				console.error("[Desktop Sync] Failed to auto-unlock:", error);
			}
		} else {
			console.log(
				`[Desktop Sync] No valid session for ${email}, cannot auto-unlock`,
			);
		}
	}

	/**
	 * Handle desktop close event
	 */
	async handleDesktopCloseEvent(_event: DesktopCloseEvent): Promise<void> {
		console.log("[Desktop Sync] Desktop closed, locking extension");

		// Lock extension immediately
		await lock();

		// Mark desktop as unavailable
		this.desktopAvailable = false;
		this.lastDesktopStatus = null;

		// Close SSE connection
		if (this.eventSource) {
			this.eventSource.close();
			this.eventSource = null;
		}
	}

	/**
	 * Start polling for desktop status
	 */
	startPolling(): void {
		if (this.pollInterval) return;

		console.log("[Desktop Sync] Starting status polling");
		this.pollInterval = setInterval(async () => {
			await this.checkDesktopStatus();
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
}

// Export singleton instance
export const desktopSync = new DesktopSyncService();
