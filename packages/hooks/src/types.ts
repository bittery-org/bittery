/**
 * Shared Hooks Type Definitions
 *
 * Interfaces for platform-specific dependencies that hooks require.
 * Apps provide implementations via PlatformProvider.
 */

import type { EncryptedData } from "@bittery/types";

/**
 * Item decryption interface.
 * Each platform implements this using its crypto backend (WASM, Tauri, FFI).
 */
export interface IItemDecrypt {
	/**
	 * Decrypt encrypted item data using AES-256-GCM.
	 * @param encryptedData - The encrypted data object (ciphertext, iv, algorithm)
	 * @param vaultKey - The decrypted vault key (256-bit)
	 * @returns Decrypted JSON string containing item data
	 */
	decrypt(encryptedData: EncryptedData, vaultKey: Uint8Array): Promise<string>;
}

/**
 * Autolock service interface.
 * Each platform implements activity tracking and locking behavior.
 */
export interface IAutolockService {
	/**
	 * Initialize the autolock service.
	 * Sets up activity listeners and timer.
	 */
	initialize(): Promise<void>;

	/**
	 * Record user activity to reset the inactivity timer.
	 * Called on user interactions (clicks, keypresses, etc.)
	 */
	recordActivity(): void;

	/**
	 * Check if the app should be locked due to inactivity.
	 */
	shouldLock(): Promise<boolean>;

	/**
	 * Lock the app immediately.
	 * Clears MUK from memory and navigates to unlock screen.
	 */
	lock(): Promise<void>;

	/**
	 * Register a callback to be called when lock occurs.
	 * @returns Cleanup function to unregister the callback
	 */
	onLock(callback: () => void): () => void;

	/**
	 * Get the current autolock timeout in milliseconds.
	 * @returns Timeout in ms, or -1 for "never"
	 */
	getTimeout(): Promise<number>;

	/**
	 * Set the autolock timeout.
	 * @param ms - Timeout in milliseconds, or -1 for "never"
	 */
	setTimeout(ms: number): Promise<void>;

	/**
	 * Clean up resources (timers, listeners).
	 * Called when the app is unmounting.
	 */
	dispose(): void;
}

/**
 * Raw encrypted item from API (matches tRPC vault.listItems response)
 */
export interface RawEncryptedItem {
	id: string;
	vaultId: string;
	category: string;
	favorite: boolean;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	createdAt: string;
	updatedAt: string;
	deletedAt?: string | null;
}

/**
 * Raw encrypted item with vault metadata (matches tRPC vault.listAllItems response)
 */
export interface RawEncryptedItemWithVault extends RawEncryptedItem {
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
}
