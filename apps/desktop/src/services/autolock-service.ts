/**
 * Desktop Autolock Service
 *
 * Implements activity-based autolock for the desktop app.
 * Tracks user activity (mouse, keyboard, window focus) and triggers
 * lockAllAccounts when timeout is exceeded.
 */

import type { IAutolockService } from "@bittery/types";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * DOM activity events to track
 */
const ACTIVITY_EVENTS = [
	"mousedown",
	"mousemove",
	"keydown",
	"scroll",
	"touchstart",
	"click",
] as const;

/**
 * Create a desktop autolock service instance
 *
 * @param storage - Storage adapter for reading/writing timeout settings
 * @param onLock - Callback to execute when lock should occur (lockAllAccounts)
 * @returns IAutolockService instance
 */
export function createDesktopAutolockService(
	storage: IStorageAdapter,
	onLock: () => Promise<void>,
): IAutolockService {
	let intervalId: ReturnType<typeof setInterval> | null = null;
	let lastActivityTime = Date.now();
	let isInitialized = false;
	let isDisposed = false;
	const lockCallbacks: Set<() => void> = new Set();
	const unlistenFns: UnlistenFn[] = [];

	// Activity event handler
	const handleActivity = () => {
		if (isDisposed) return;
		lastActivityTime = Date.now();
	};

	// Check if enough time has passed to require lock
	const shouldLock = async (): Promise<boolean> => {
		if (isDisposed) return false;

		const timeoutMs = await storage.getAutoLockTimeoutOrDefault();

		// -1 means never auto-lock
		if (timeoutMs < 0) return false;

		const elapsed = Date.now() - lastActivityTime;

		return elapsed >= timeoutMs;
	};

	// Execute lock
	const lock = async (): Promise<void> => {
		if (isDisposed) return;

		// Clear interval
		if (intervalId !== null) {
			clearInterval(intervalId);
			intervalId = null;
		}

		// Call onLock callback first (lockAllAccounts)
		await onLock();

		// Notify all additional callbacks
		for (const callback of lockCallbacks) {
			try {
				callback();
			} catch (error) {
				console.error("Error in lock callback:", error);
			}
		}
	};

	// Check timer - runs every second
	const checkTimer = async () => {
		if (isDisposed) return;

		const shouldLockNow = await shouldLock();
		if (shouldLockNow) {
			console.log("[Desktop Autolock] Timeout exceeded, locking");
			await lock();
		}
	};

	return {
		async initialize(): Promise<void> {
			if (isInitialized || isDisposed) return;

			console.log("[Desktop Autolock] Initializing");
			isInitialized = true;
			lastActivityTime = Date.now();

			// Add DOM activity event listeners
			if (typeof window !== "undefined" && typeof document !== "undefined") {
				for (const event of ACTIVITY_EVENTS) {
					window.addEventListener(event, handleActivity, { passive: true });
				}
			}

			// Add Tauri window focus/blur listeners
			try {
				// Listen for window focus events
				const unlistenFocus = await listen("tauri://focus", () => {
					console.log("[Desktop Autolock] Window focused");
					handleActivity();
				});
				unlistenFns.push(unlistenFocus);

				// Listen for window blur events
				const unlistenBlur = await listen("tauri://blur", () => {
					console.log("[Desktop Autolock] Window blurred");
					handleActivity();
				});
				unlistenFns.push(unlistenBlur);
			} catch (error) {
				console.error(
					"[Desktop Autolock] Failed to set up Tauri listeners:",
					error,
				);
			}

			// Start interval timer (check every second)
			intervalId = setInterval(checkTimer, 5000);

			console.log("[Desktop Autolock] Initialized successfully");
		},

		recordActivity(): void {
			if (isDisposed) return;
			handleActivity();
		},

		shouldLock,

		lock,

		onLock(callback: () => void): () => void {
			lockCallbacks.add(callback);
			return () => {
				lockCallbacks.delete(callback);
			};
		},

		async getTimeout(): Promise<number> {
			return storage.getAutoLockTimeoutOrDefault();
		},

		async setTimeout(ms: number): Promise<void> {
			await storage.storeAutoLockTimeout(ms);
			// Timer will pick up new value on next check
		},

		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;

			console.log("[Desktop Autolock] Disposing");

			// Clear interval
			if (intervalId !== null) {
				clearInterval(intervalId);
				intervalId = null;
			}

			// Remove DOM event listeners
			if (typeof window !== "undefined" && typeof document !== "undefined") {
				for (const event of ACTIVITY_EVENTS) {
					window.removeEventListener(event, handleActivity);
				}
			}

			// Remove Tauri event listeners
			for (const unlisten of unlistenFns) {
				unlisten();
			}
			unlistenFns.length = 0;

			// Clear callbacks
			lockCallbacks.clear();
		},
	};
}
