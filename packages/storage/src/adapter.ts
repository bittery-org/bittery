/**
 * Storage Adapter Interface
 * Common interface for all platform-specific storage implementations
 */

import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemCacheMetadata,
	KdfParams,
} from "@bittery/types";
import type { SessionExpiryInput } from "./session";
import type {
	AccountMetadata,
	ActiveAccount,
	BiometricAuthResult,
	Platform,
	StoredSessionData,
	VaultKeyData,
} from "./types";

/**
 * IStorageAdapter defines the contract for platform-specific storage implementations.
 * All methods are async to accommodate Chrome extension storage, SecureStore, Tauri Store, etc.
 * Optional accountId parameter supports multi-account platforms (desktop/mobile).
 * accountId is the stable local identifier; email is display metadata only.
 */
export interface IStorageAdapter {
	// ============================================================================
	// Identity
	// ============================================================================

	/** Platform identifier */
	readonly platform: Platform;

	/** Whether this adapter supports multiple accounts */
	readonly supportsMultiAccount: boolean;

	/** Whether this adapter supports biometric authentication */
	readonly supportsBiometric: boolean;

	// ============================================================================
	// Initialization
	// ============================================================================

	/**
	 * Initialize the storage adapter.
	 * Called once when the app starts. Should set up any required databases,
	 * migrate storage if needed, etc.
	 */
	initialize(): Promise<void>;

	// ============================================================================
	// Session Management
	// ============================================================================

	/**
	 * Get Master Unlock Key from memory cache.
	 * If not in memory but session is valid, may restore from encrypted storage.
	 */
	getMasterUnlockKey(accountId?: string): Promise<Uint8Array | null>;

	/**
	 * Store Master Unlock Key in memory cache.
	 * Note: This does NOT persist to disk; use storeSessionData for persistence.
	 */
	setMasterUnlockKey(key: Uint8Array, accountId?: string): Promise<void>;

	/**
	 * Store Master Unlock Key as an opaque crypto handle when supported.
	 */
	setMasterUnlockKeyHandle?(
		keyHandle: number,
		accountId?: string,
	): Promise<void>;

	/**
	 * Clear Master Unlock Key from memory.
	 * Called when locking the app.
	 */
	clearMasterUnlockKey(accountId?: string): Promise<void>;

	/**
	 * Get Master Unlock Key handle from memory cache.
	 */
	getMasterUnlockKeyHandle?(accountId?: string): Promise<number | null>;

	/**
	 * Store encrypted session data for persistence.
	 * MUK is encrypted with device key before storage.
	 */
	storeSessionData(
		muk: Uint8Array,
		accountId: string,
		email: string,
		userId: string,
		expiresAt?: SessionExpiryInput,
		sessionId?: string,
	): Promise<void>;

	/**
	 * Store encrypted session data from an opaque MUK handle.
	 */
	storeSessionDataWithMasterUnlockKeyHandle?(
		keyHandle: number,
		accountId: string,
		email: string,
		userId: string,
		expiresAt?: SessionExpiryInput,
		sessionId?: string,
	): Promise<void>;

	updateStoredSessionMetadata?(
		accountId: string,
		metadata: {
			sessionId?: string;
			expiresAt: SessionExpiryInput;
		},
	): Promise<void>;

	/**
	 * Try to restore session from persistent storage.
	 * Returns true if successfully restored MUK to memory.
	 * @param skipBiometric - If true, skip biometric prompt even if enabled
	 */
	tryRestoreSession(
		skipBiometric?: boolean,
		accountId?: string,
	): Promise<boolean>;

	/**
	 * Check if stored session is still valid (not expired).
	 */
	isSessionValid(accountId?: string): Promise<boolean>;

	// ============================================================================
	// Credentials
	// ============================================================================

	/**
	 * Store Secret Key (plaintext - safe because useless without password).
	 */
	storeSecretKey(key: string, accountId?: string): Promise<void>;

	/**
	 * Get stored Secret Key.
	 */
	getStoredSecretKey(accountId?: string): Promise<string | null>;

	/**
	 * Store JWT auth token.
	 */
	storeAuthToken(token: string, accountId?: string): Promise<void>;

	/**
	 * Get stored JWT auth token.
	 */
	getAuthToken(accountId?: string): Promise<string | null>;

	/**
	 * Store encrypted vault keys.
	 */
	storeVaultKeys(keys: VaultKeyData[], accountId?: string): Promise<void>;

	/**
	 * Get encrypted vault keys.
	 */
	getVaultKeys(accountId?: string): Promise<VaultKeyData[] | null>;

	/**
	 * Store encrypted private key (for RSA operations / vault sharing).
	 */
	storeEncryptedPrivateKey(key: string, accountId?: string): Promise<void>;

	/**
	 * Get encrypted private key.
	 */
	getEncryptedPrivateKey(accountId?: string): Promise<string | null>;

	/**
	 * Store pinned login KDF parameters for downgrade/tamper detection.
	 */
	storePinnedKdfParams(params: KdfParams, accountId?: string): Promise<void>;

	/**
	 * Get pinned login KDF parameters.
	 */
	getPinnedKdfParams(accountId?: string): Promise<KdfParams | null>;

	// ============================================================================
	// Multi-Account (desktop/mobile)
	// ============================================================================

	/**
	 * Get the currently active account configuration.
	 * Returns:
	 * - { type: "single", accountId: string } - A specific account is active
	 * - { type: "all" } - All unlocked accounts are active (multi-account mode)
	 * - null - No account is active (logged out)
	 */
	getActiveAccount(): Promise<ActiveAccount>;

	/**
	 * Get the currently active account user ID.
	 * Returns null if no account is active or if in "all accounts" mode.
	 */
	getActiveAccountUserId(): Promise<string | null>;

	/**
	 * Set the active account.
	 * @param account - Account configuration to set as active
	 */
	setActiveAccount(account: ActiveAccount): Promise<void>;

	/**
	 * Get list of all accounts.
	 */
	getAccountsList(): Promise<AccountMetadata[]>;

	/**
	 * Add a new account to the accounts list.
	 */
	addAccount(metadata: AccountMetadata): Promise<void>;

	/**
	 * Remove an account and all its data.
	 */
	removeAccount(accountId: string): Promise<void>;

	// ============================================================================
	// Settings
	// ============================================================================

	/**
	 * Store auto-lock timeout preference.
	 * @param ms - Timeout in milliseconds, or -1 for never
	 */
	storeAutoLockTimeout(ms: number, accountId?: string): Promise<void>;

	/**
	 * Get auto-lock timeout preference.
	 * Returns null if not explicitly set.
	 */
	getAutoLockTimeout(accountId?: string): Promise<number | null>;

	/**
	 * Get auto-lock timeout, returning default if not set.
	 */
	getAutoLockTimeoutOrDefault(accountId?: string): Promise<number>;

	/**
	 * Store custom server URL (for self-hosted instances).
	 */
	storeServerUrl(url: string, accountId?: string): Promise<void>;

	/**
	 * Get stored server URL.
	 */
	getServerUrl(accountId?: string): Promise<string | null>;

	// ============================================================================
	// Auth State
	// ============================================================================

	/**
	 * Check if user is authenticated (has valid auth token).
	 */
	isAuthenticated(accountId?: string): Promise<boolean>;

	/**
	 * Check if quick unlock is available.
	 * Requires: stored secret key + valid session
	 */
	canQuickUnlock(accountId?: string): Promise<boolean>;

	// ============================================================================
	// Clear
	// ============================================================================

	/**
	 * Clear session data (logout but keep secret key for quick unlock).
	 */
	clearSession(accountId?: string): Promise<void>;

	/**
	 * Clear all stored data including secret key (complete logout).
	 */
	clearAllStoredData(accountId?: string): Promise<void>;

	// ============================================================================
	// Biometric (optional, check supportsBiometric first)
	// ============================================================================

	/**
	 * Check if biometric hardware is available.
	 */
	isBiometricAvailable?(): Promise<boolean>;

	/**
	 * Check if biometric unlock is enabled for this account.
	 */
	isBiometricEnabled?(accountId?: string): Promise<boolean>;

	/**
	 * Enable biometric unlock for this account.
	 */
	enableBiometric?(accountId?: string): Promise<void>;

	/**
	 * Disable biometric unlock for this account.
	 */
	disableBiometric?(accountId?: string): Promise<void>;

	/**
	 * Authenticate using biometric (Touch ID / Face ID / Windows Hello).
	 * Returns true if authentication succeeded.
	 */
	authenticateWithBiometric?(
		reason?: string,
		accountId?: string,
	): Promise<boolean>;

	/**
	 * Check if biometric unlock is available.
	 * Requires: biometric hardware + enabled by user + valid session
	 */
	canBiometricUnlock?(accountId?: string): Promise<boolean>;

	// ============================================================================
	// Extended Session Management (unified interface for all platforms)
	// ============================================================================

	/**
	 * Get stored session data (for checking expiry, biometric status, etc.)
	 * Returns session metadata without decrypting the Master Unlock Key.
	 */
	getStoredSessionData?(accountId?: string): Promise<StoredSessionData | null>;

	/**
	 * Check if secret key is stored for an account.
	 */
	hasStoredSecretKey?(accountId?: string): Promise<boolean>;

	/**
	 * Lock all accounts (clear MUK from memory, require re-auth).
	 * Clears all in-memory caches and biometric auth timestamps.
	 */
	lockAllAccounts?(): Promise<void>;

	/**
	 * Get metadata for a specific account.
	 */
	getAccountMetadata?(accountId: string): Promise<AccountMetadata | null>;

	/**
	 * Get list of unlocked account IDs (accounts with MUK currently in memory).
	 * Used for multi-account operations and "All Accounts" view.
	 */
	getUnlockedAccounts?(): Promise<string[]>;

	// ============================================================================
	// Extended Biometric (optional, check supportsBiometric first)
	// ============================================================================

	/**
	 * Get detailed biometric availability info.
	 * Returns whether hardware exists and whether biometrics are enrolled.
	 */
	getBiometricAvailabilityDetails?(): Promise<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}>;

	/**
	 * Get biometric type available on device.
	 * @returns "Face ID" | "Touch ID" | "Fingerprint" | null
	 */
	getBiometricType?(): Promise<string | null>;

	/**
	 * Unlock with biometric (authenticates + restores MUK to memory).
	 * Combines biometric authentication with MUK restoration in one operation.
	 */
	unlockWithBiometric?(accountId?: string): Promise<boolean>;

	/**
	 * Unlock all accounts with biometric authentication.
	 * Shows ONE biometric prompt and unlocks all accounts that support biometric.
	 * Returns lists of successfully unlocked and failed accounts.
	 * Desktop/Mobile only - returns undefined for web/extension.
	 */
	unlockAllAccountsWithBiometric?(): Promise<{
		unlocked: string[];
		failed: Array<{ accountId: string; error: string }>;
	}>;

	/**
	 * Enhanced biometric auth with detailed error handling.
	 * Returns structured result with specific error types for UI handling.
	 */
	authenticateWithBiometricEnhanced?(
		reason?: string,
		accountId?: string,
	): Promise<BiometricAuthResult>;

	// ============================================================================
	// Mobile-Specific (optional, check platform first)
	// ============================================================================

	// ============================================================================
	// Item Cache
	// ============================================================================

	/** Whether this adapter supports local item caching */
	readonly supportsItemCache: boolean;

	/** Store all cached items (bulk, for initial sync) */
	setCachedItems?(
		items: CachedEncryptedItem[],
		accountId?: string,
	): Promise<void>;

	/** Get all cached items */
	getCachedItems?(accountId?: string): Promise<CachedEncryptedItem[] | null>;

	/** Insert or update a single cached item */
	upsertCachedItem?(
		item: CachedEncryptedItem,
		accountId?: string,
	): Promise<void>;

	/** Remove a single cached item */
	removeCachedItem?(itemId: string, accountId?: string): Promise<void>;

	/** Store all cached vault metadata (bulk) */
	setCachedVaults?(
		vaults: CachedVaultMetadata[],
		accountId?: string,
	): Promise<void>;

	/** Get all cached vault metadata */
	getCachedVaults?(accountId?: string): Promise<CachedVaultMetadata[] | null>;

	/** Insert or update a single cached vault */
	upsertCachedVault?(
		vault: CachedVaultMetadata,
		accountId?: string,
	): Promise<void>;

	/** Remove a cached vault and its items */
	removeCachedVault?(vaultId: string, accountId?: string): Promise<void>;

	/** Get item cache metadata */
	getItemCacheMetadata?(accountId?: string): Promise<ItemCacheMetadata | null>;

	/** Set item cache metadata */
	setItemCacheMetadata?(
		metadata: ItemCacheMetadata,
		accountId?: string,
	): Promise<void>;

	/** Clear all item cache data */
	clearItemCache?(accountId?: string): Promise<void>;

	// ============================================================================
	// Travel Mode (optional)
	// ============================================================================

	/** Store cached travel mode config for an account */
	storeTravelModeCache?(
		config: import("./types").TravelModeConfig,
		accountId?: string,
	): Promise<void>;

	/** Get cached travel mode config for an account */
	getTravelModeCache?(
		accountId?: string,
	): Promise<import("./types").TravelModeConfig | null>;

	// ============================================================================
	// Mobile-Specific (optional, check platform first)
	// ============================================================================

	/**
	 * Check if master password re-entry is required by security policy.
	 * Platform-specific security feature.
	 */
	isMasterPasswordReentryRequired?(accountId?: string): Promise<boolean>;

	/**
	 * Update last master password entry timestamp.
	 * Called after user successfully authenticates with password.
	 */
	updateLastMasterPasswordEntry?(accountId?: string): Promise<void>;

	/**
	 * Decrypt stored MUK (public wrapper for unlock flows).
	 * Returns decrypted Master Unlock Key or null if unavailable.
	 * @param skipBiometric - If true, skip biometric prompt even if enabled
	 */
	decryptStoredMasterUnlockKey?(
		accountId?: string,
		skipBiometric?: boolean,
	): Promise<Uint8Array | null>;
}
