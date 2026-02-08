/**
 * Web Autolock Service
 *
 * Implements IAutolockService for web browsers using:
 * - setTimeout for inactivity tracking
 * - Document visibility API for tab switching detection
 * - Event listeners for user activity tracking
 */

import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { IAutolockService } from "../types";

/**
 * Activity events to track for resetting the inactivity timer
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
 * Create a web autolock service instance
 *
 * @param storage - Storage adapter for reading/writing timeout settings
 * @param onLock - Callback to execute when lock should occur
 * @returns IAutolockService instance
 */
export function createWebAutolockService(
	storage: IStorageAdapter,
): IAutolockService {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let lastActivityTime = Date.now();
	let isInitialized = false;
	let isDisposed = false;
	const lockCallbacks: Set<() => void> = new Set();

	// Activity event handler
	const handleActivity = () => {
		if (isDisposed) return;
		lastActivityTime = Date.now();
		resetTimer();
	};

	// Visibility change handler - lock immediately when tab becomes hidden
	// and check lock status when tab becomes visible
	const handleVisibilityChange = async () => {
		if (isDisposed) return;

		if (document.visibilityState === "hidden") {
			// Tab is hidden - record the time
			lastActivityTime = Date.now();
		} else if (document.visibilityState === "visible") {
			// Tab is visible again - check if we should lock
			const shouldLockNow = await shouldLock();
			if (shouldLockNow) {
				await lock();
			} else {
				// Reset timer since we're back
				resetTimer();
			}
		}
	};

	// Reset the inactivity timer
	const resetTimer = async () => {
		if (isDisposed) return;

		// Clear existing timer
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}

		// Get current timeout setting
		const timeoutMs = await storage.getAutoLockTimeoutOrDefault();

		// -1 means never auto-lock
		if (timeoutMs < 0) return;

		// Set new timer
		timeoutId = setTimeout(async () => {
			if (!isDisposed) {
				const shouldLockNow = await shouldLock();
				if (shouldLockNow) {
					await lock();
				}
			}
		}, timeoutMs);
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

		// Clear timer
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}

		// Clear MUK from storage
		await storage.clearMasterUnlockKey();

		// Notify all callbacks
		for (const callback of lockCallbacks) {
			try {
				callback();
			} catch (error) {
				console.error("Error in lock callback:", error);
			}
		}
	};

	return {
		async initialize(): Promise<void> {
			if (isInitialized || isDisposed) return;

			// Only initialize in browser environment
			if (typeof window === "undefined" || typeof document === "undefined") {
				return;
			}

			isInitialized = true;
			lastActivityTime = Date.now();

			// Add activity event listeners
			for (const event of ACTIVITY_EVENTS) {
				window.addEventListener(event, handleActivity, { passive: true });
			}

			// Add visibility change listener
			document.addEventListener("visibilitychange", handleVisibilityChange);

			// Start the timer
			await resetTimer();
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
			// Reset timer with new timeout
			await resetTimer();
		},

		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;

			// Clear timer
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}

			// Remove event listeners (only in browser)
			if (typeof window !== "undefined" && typeof document !== "undefined") {
				for (const event of ACTIVITY_EVENTS) {
					window.removeEventListener(event, handleActivity);
				}
				document.removeEventListener(
					"visibilitychange",
					handleVisibilityChange,
				);
			}

			// Clear callbacks
			lockCallbacks.clear();
		},
	};
}
