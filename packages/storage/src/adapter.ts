/**
 * Storage Adapter Interface
 * Common interface for all platform-specific storage implementations
 */

import type {
	AccountMetadata,
	BiometricAuthResult,
	Platform,
	StoredSessionData,
	VaultKeyData,
} from "./types";

/**
 * IStorageAdapter defines the contract for platform-specific storage implementations.
 * All methods are async to accommodate Chrome extension storage, SecureStore, Tauri Store, etc.
 * Optional email parameter supports multi-account platforms (desktop/mobile).
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
	getMasterUnlockKey(email?: string): Promise<Uint8Array | null>;

	/**
	 * Store Master Unlock Key in memory cache.
	 * Note: This does NOT persist to disk; use storeSessionData for persistence.
	 */
	setMasterUnlockKey(key: Uint8Array, email?: string): Promise<void>;

	/**
	 * Clear Master Unlock Key from memory.
	 * Called when locking the app.
	 */
	clearMasterUnlockKey(email?: string): Promise<void>;

	/**
	 * Store encrypted session data for persistence.
	 * MUK is encrypted with device key before storage.
	 */
	storeSessionData(
		muk: Uint8Array,
		email: string,
		userId: string,
		expiryMs?: number,
	): Promise<void>;

	/**
	 * Try to restore session from persistent storage.
	 * Returns true if successfully restored MUK to memory.
	 * @param skipBiometric - If true, skip biometric prompt even if enabled
	 */
	tryRestoreSession(skipBiometric?: boolean, email?: string): Promise<boolean>;

	/**
	 * Check if stored session is still valid (not expired).
	 */
	isSessionValid(email?: string): Promise<boolean>;

	// ============================================================================
	// Credentials
	// ============================================================================

	/**
	 * Store Secret Key (plaintext - safe because useless without password).
	 */
	storeSecretKey(key: string, email?: string): Promise<void>;

	/**
	 * Get stored Secret Key.
	 */
	getStoredSecretKey(email?: string): Promise<string | null>;

	/**
	 * Store JWT auth token.
	 */
	storeAuthToken(token: string, email?: string): Promise<void>;

	/**
	 * Get stored JWT auth token.
	 */
	getAuthToken(email?: string): Promise<string | null>;

	/**
	 * Store encrypted vault keys.
	 */
	storeVaultKeys(keys: VaultKeyData[], email?: string): Promise<void>;

	/**
	 * Get encrypted vault keys.
	 */
	getVaultKeys(email?: string): Promise<VaultKeyData[] | null>;

	/**
	 * Get decrypted vault key for a specific vault.
	 * Requires MUK to be available in memory.
	 */
	getDecryptedVaultKey(
		vaultId: string,
		email?: string,
	): Promise<Uint8Array | null>;

	/**
	 * Decrypt a vault key string (AES-GCM or RSA encrypted).
	 * Requires MUK to be available in memory.
	 */
	decryptVaultKey(
		encryptedVaultKey: string,
		email?: string,
	): Promise<Uint8Array>;

	/**
	 * Store encrypted private key (for RSA operations / vault sharing).
	 */
	storeEncryptedPrivateKey(key: string, email?: string): Promise<void>;

	/**
	 * Get encrypted private key.
	 */
	getEncryptedPrivateKey(email?: string): Promise<string | null>;

	// ============================================================================
	// Multi-Account (desktop/mobile)
	// ============================================================================

	/**
	 * Get the currently active account email.
	 * Returns null if no account is active.
	 */
	getActiveAccountEmail(): Promise<string | null>;

	/**
	 * Get the currently active account user ID.
	 * Returns null if no account is active.
	 */
	getActiveAccountUserId(): Promise<string | null>;

	/**
	 * Set the active account.
	 */
	setActiveAccount(email: string): Promise<void>;

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
	removeAccount(email: string): Promise<void>;

	// ============================================================================
	// Settings
	// ============================================================================

	/**
	 * Store auto-lock timeout preference.
	 * @param ms - Timeout in milliseconds, or -1 for never
	 */
	storeAutoLockTimeout(ms: number, email?: string): Promise<void>;

	/**
	 * Get auto-lock timeout preference.
	 * Returns null if not explicitly set.
	 */
	getAutoLockTimeout(email?: string): Promise<number | null>;

	/**
	 * Get auto-lock timeout, returning default if not set.
	 */
	getAutoLockTimeoutOrDefault(email?: string): Promise<number>;

	/**
	 * Store custom server URL (for self-hosted instances).
	 */
	storeServerUrl(url: string, email?: string): Promise<void>;

	/**
	 * Get stored server URL.
	 */
	getServerUrl(email?: string): Promise<string | null>;

	// ============================================================================
	// Auth State
	// ============================================================================

	/**
	 * Check if user is authenticated (has valid auth token).
	 */
	isAuthenticated(email?: string): Promise<boolean>;

	/**
	 * Check if quick unlock is available.
	 * Requires: stored secret key + valid session
	 */
	canQuickUnlock(email?: string): Promise<boolean>;

	// ============================================================================
	// Clear
	// ============================================================================

	/**
	 * Clear session data (logout but keep secret key for quick unlock).
	 */
	clearSession(email?: string): Promise<void>;

	/**
	 * Clear all stored data including secret key (complete logout).
	 */
	clearAllStoredData(email?: string): Promise<void>;

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
	isBiometricEnabled?(email?: string): Promise<boolean>;

	/**
	 * Enable biometric unlock for this account.
	 */
	enableBiometric?(email?: string): Promise<void>;

	/**
	 * Disable biometric unlock for this account.
	 */
	disableBiometric?(email?: string): Promise<void>;

	/**
	 * Authenticate using biometric (Touch ID / Face ID / Windows Hello).
	 * Returns true if authentication succeeded.
	 */
	authenticateWithBiometric?(reason?: string, email?: string): Promise<boolean>;

	/**
	 * Check if biometric unlock is available.
	 * Requires: biometric hardware + enabled by user + valid session
	 */
	canBiometricUnlock?(email?: string): Promise<boolean>;

	// ============================================================================
	// Extended Session Management (unified interface for all platforms)
	// ============================================================================

	/**
	 * Get stored session data (for checking expiry, biometric status, etc.)
	 * Returns session metadata without decrypting the Master Unlock Key.
	 */
	getStoredSessionData?(email?: string): Promise<StoredSessionData | null>;

	/**
	 * Check if secret key is stored for an account.
	 */
	hasStoredSecretKey?(email?: string): Promise<boolean>;

	/**
	 * Lock all accounts (clear MUK from memory, require re-auth).
	 * Clears all in-memory caches and biometric auth timestamps.
	 */
	lockAllAccounts?(): Promise<void>;

	/**
	 * Get metadata for a specific account.
	 */
	getAccountMetadata?(email: string): Promise<AccountMetadata | null>;

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
	unlockWithBiometric?(email?: string): Promise<boolean>;

	/**
	 * Enhanced biometric auth with detailed error handling.
	 * Returns structured result with specific error types for UI handling.
	 */
	authenticateWithBiometricEnhanced?(
		reason?: string,
		email?: string,
	): Promise<BiometricAuthResult>;

	// ============================================================================
	// Mobile-Specific (optional, check platform first)
	// ============================================================================

	/**
	 * Check if master password re-entry is required (30-day security policy).
	 * Mobile-specific security feature.
	 */
	isMasterPasswordReentryRequired?(email?: string): Promise<boolean>;

	/**
	 * Update last master password entry timestamp.
	 * Called after user successfully authenticates with password.
	 */
	updateLastMasterPasswordEntry?(email?: string): Promise<void>;

	/**
	 * Decrypt stored MUK (public wrapper for unlock flows).
	 * Returns decrypted Master Unlock Key or null if unavailable.
	 * @param skipBiometric - If true, skip biometric prompt even if enabled
	 */
	decryptStoredMasterUnlockKey?(
		email?: string,
		skipBiometric?: boolean,
	): Promise<Uint8Array | null>;
}
