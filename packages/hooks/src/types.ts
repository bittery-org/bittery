/**
 * Shared Hooks Type Definitions
 *
 * Interfaces for platform-specific dependencies that hooks require.
 * Apps provide implementations via PlatformProvider.
 */

import type { ICrypto } from "@bittery/core";
import type { EncryptedData } from "@bittery/types";

export type {
	DerivedKeys,
	SRPClientEphemeral,
	SRPClientSession,
	SRPServerChallenge,
} from "@bittery/core";
export type { ICrypto };

/**
 * Query invalidator interface for cache invalidation after mutations.
 * Matches the return type of createQueryInvalidator() from @bittery/sync.
 */
export interface IQueryInvalidator {
	/**
	 * Invalidate item-related queries.
	 * @param itemId - The item that was modified
	 * @param vaultId - The vault containing the item
	 */
	invalidateItem(itemId: string, vaultId: string): Promise<void>;

	/**
	 * Invalidate vault list (items in vault) queries.
	 * @param vaultId - The vault to invalidate
	 */
	invalidateVaultList(vaultId: string): Promise<void>;

	/**
	 * Invalidate vault keys cache.
	 */
	invalidateVaultKeys(): Promise<void>;

	/**
	 * Invalidate deleted items list queries.
	 * @param vaultId - The vault to invalidate
	 */
	invalidateDeletedItems(vaultId: string): Promise<void>;

	/**
	 * Invalidate team-related queries.
	 */
	invalidateTeam(): Promise<void>;

	/**
	 * Invalidate team invitations queries.
	 */
	invalidateTeamInvitations(): Promise<void>;

	/**
	 * Invalidate share-related queries.
	 * @param itemId - Optional item ID for specific share invalidation
	 */
	invalidateShare(itemId?: string): Promise<void>;

	/**
	 * Invalidate vault member queries.
	 * @param vaultId - The vault to invalidate members for
	 */
	invalidateVaultMembers(vaultId: string): Promise<void>;
}

/**
 * Sync context - subset of sync state needed by shared hooks.
 * Wraps each platform's sync provider to provide query invalidation.
 */
export interface ISyncContext {
	/** Unique client identifier for this device/session */
	clientId: string;

	/** Whether the WebSocket is currently connected */
	isConnected: boolean;

	/** Whether the device has network connectivity */
	isOnline: boolean;

	/** Query invalidator for cache management */
	invalidator: IQueryInvalidator;
}

/**
 * Item decryption interface.
 * @deprecated Use ICrypto instead. This interface will be removed in a future version.
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
