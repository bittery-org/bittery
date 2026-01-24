/**
 * React Native Storage Adapter with Biometric Authentication
 * Adapts session-storage.ts to use Expo's secure storage APIs with Face ID/Touch ID
 *
 * Uses:
 * - expo-secure-store for sensitive small data (< 2KB)
 * - expo-sqlite for larger data and offline queue
 * - expo-local-authentication for biometric auth
 */

import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
// Static imports for React Native - these are bundled by Metro at build time
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";
import { decrypt, type EncryptedData, encrypt } from "./encryption";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./key-derivation";
import { rsaDecrypt } from "./rsa";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_STORAGE = "bittery_device_key";
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";

// Helper to generate namespaced keys for each account
function getAccountKey(email: string, suffix: string): string {
	// Sanitize email for use as key (replace special chars)
	const sanitized = email.toLowerCase().replace(/[^a-z0-9]/g, "_");
	return `bittery_account_${sanitized}_${suffix}`;
}

// Default session expiry: 14 days (in milliseconds)
export const DEFAULT_SESSION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

// Biometric authentication grace period: 10 minutes (in milliseconds)
export const BIOMETRIC_GRACE_PERIOD_MS = 10 * 60 * 1000;

// Periodic master password re-entry: 30 days (in milliseconds)
export const MASTER_PASSWORD_REENTRY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

// App background lock timeout: Uses the auto-lock timeout setting
// After this time in background, biometric re-auth is required

export interface StoredSessionData {
	encryptedMasterUnlockKey: EncryptedData;
	email: string;
	userId: string;
	expiresAt: number; // timestamp
	createdAt: number; // timestamp
	biometricEnabled?: boolean;
	lastMasterPasswordEntry?: number; // timestamp of last master password authentication
}

// Error types for biometric authentication
export type BiometricErrorType =
	| "not_available" // Device doesn't have biometric hardware
	| "not_enrolled" // No biometrics enrolled on device
	| "not_enabled" // User hasn't enabled biometric for this account
	| "authentication_failed" // Biometric didn't match
	| "user_cancelled" // User cancelled the prompt
	| "lockout" // Too many failed attempts
	| "master_password_required" // Periodic re-entry required
	| "session_expired" // Session has expired
	| "unknown"; // Unknown error

export interface BiometricAuthResult {
	success: boolean;
	error?: BiometricErrorType;
	message?: string;
}

export interface VaultKeyData {
	vaultId: string;
	vaultName: string;
	vaultType: "personal" | "team";
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

export interface AccountMetadata {
	email: string;
	userId: string;
	name: string;
	teamName?: string;
	secretKeyHint: string;
	addedAt: number;
	lastActiveAt: number;
	biometricEnabled: boolean;
}

interface AccountsList {
	accounts: AccountMetadata[];
}

// Per-account cache structure
interface AccountCache {
	authToken: string | null;
	vaultKeys: VaultKeyData[] | null;
	masterUnlockKey: Uint8Array | null;
}

// In-memory caches - keyed by email
const accountCaches: Map<string, AccountCache> = new Map();

// SQLite database instance
type SQLiteDatabase = Awaited<ReturnType<typeof SQLite.openDatabaseAsync>>;
let db: SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLiteDatabase | null> | null = null;

async function getDatabase() {
	// Return existing database if available
	if (db) {
		return db;
	}

	// If initialization is in progress, wait for it
	if (dbInitPromise) {
		return dbInitPromise;
	}

	// Start initialization
	dbInitPromise = (async () => {
		try {
			const database = await SQLite.openDatabaseAsync("bittery.db");
			// Initialize tables
			await database.execAsync(`
				CREATE TABLE IF NOT EXISTS kv_store (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS offline_queue (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					operation TEXT NOT NULL,
					payload TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					retry_count INTEGER DEFAULT 0
				);
			`);
			db = database;
			return db;
		} catch (error) {
			console.error("[storage-react-native] Failed to initialize SQLite database:", error);
			dbInitPromise = null; // Allow retry on next call
			return null;
		}
	})();

	return dbInitPromise;
}

// SecureStore has a 2KB limit, so we use SQLite for larger data
async function setItem(key: string, value: string): Promise<void> {
	// For sensitive data under 2KB, use SecureStore
	if (value.length < 2000) {
		try {
			await SecureStore.setItemAsync(key, value);
			return;
		} catch (secureStoreError) {
			// Fall back to SQLite if SecureStore fails
			console.warn(
				"[storage-react-native] SecureStore setItem failed, falling back to SQLite:",
				secureStoreError,
			);
		}
	}
	// Use SQLite for larger data or as fallback
	try {
		const database = await getDatabase();
		if (database) {
			await database.runAsync(
				"INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
				[key, value],
			);
		}
	} catch (sqliteError) {
		console.error("[storage-react-native] SQLite setItem failed:", sqliteError);
		// Last resort: try SecureStore even for larger data (may truncate)
		if (value.length >= 2000) {
			try {
				await SecureStore.setItemAsync(key, value);
			} catch (fallbackError) {
				console.error(
					"[storage-react-native] All storage methods failed for key:",
					key,
					fallbackError,
				);
				throw new Error(`Failed to store item: ${key}`);
			}
		} else {
			throw sqliteError;
		}
	}
}

async function getItem(key: string): Promise<string | null> {
	// Try SecureStore first
	try {
		const value = await SecureStore.getItemAsync(key);
		if (value !== null) return value;
	} catch (secureStoreError) {
		// Fall back to SQLite
		console.warn(
			"[storage-react-native] SecureStore getItem failed, trying SQLite:",
			secureStoreError,
		);
	}
	// Try SQLite
	try {
		const database = await getDatabase();
		if (database) {
			const result = await database.getFirstAsync<{ value: string }>(
				"SELECT value FROM kv_store WHERE key = ?",
				[key],
			);
			return result?.value ?? null;
		}
	} catch (sqliteError) {
		console.error("[storage-react-native] SQLite getItem failed:", sqliteError);
	}
	return null;
}

async function deleteItem(key: string): Promise<void> {
	// Delete from SecureStore
	try {
		await SecureStore.deleteItemAsync(key);
	} catch {
		// Ignore errors
	}
	// Delete from SQLite
	try {
		const database = await getDatabase();
		if (database) {
			await database.runAsync("DELETE FROM kv_store WHERE key = ?", [key]);
		}
	} catch (sqliteError) {
		console.warn(
			"[storage-react-native] SQLite deleteItem failed:",
			sqliteError,
		);
	}
}

// ============================================================================
// Server URL Functions (Account-Scoped)
// ============================================================================

/**
 * Store server URL for an account
 * Each account can have a different server URL (for self-hosted instances)
 */
export async function storeServerUrl(
	serverUrl: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "server_url");
	await setItem(key, serverUrl);
}

/**
 * Get the server URL for an account
 */
export async function getServerUrl(email?: string): Promise<string | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const key = getAccountKey(resolvedEmail, "server_url");
	return await getItem(key);
}

/**
 * Clear server URL for an account
 */
export async function clearServerUrl(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	const key = getAccountKey(resolvedEmail, "server_url");
	await deleteItem(key);
}

// ============================================================================
// Web App URL Functions (Account-Scoped)
// ============================================================================

/**
 * Store a custom web app URL for an account
 */
export async function storeWebAppUrl(
	webAppUrl: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "web_app_url");
	await setItem(key, webAppUrl);
}

/**
 * Get the custom web app URL for an account
 */
export async function getWebAppUrl(email?: string): Promise<string | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const key = getAccountKey(resolvedEmail, "web_app_url");
	return await getItem(key);
}

/**
 * Clear the custom web app URL for an account
 */
export async function clearWebAppUrl(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	const key = getAccountKey(resolvedEmail, "web_app_url");
	await deleteItem(key);
}

/**
 * Get the effective web app URL for generating share links
 */
export async function getEffectiveWebAppUrl(email?: string): Promise<string> {
	const customUrl = await getWebAppUrl(email);
	if (customUrl) {
		return customUrl.replace(/\/$/, "");
	}

	const serverUrl = await getServerUrl(email);
	if (serverUrl) {
		return serverUrl.replace(/\/api.*$/, "").replace(/\/$/, "");
	}

	return "https://app.bittery.io";
}

// ============================================================================
// Auto-Lock Timeout Functions (Account-Scoped)
// ============================================================================

export const DEFAULT_AUTO_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Store auto-lock timeout preference for an account
 */
export async function storeAutoLockTimeout(
	timeoutMs: number,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
	await setItem(key, timeoutMs.toString());
}

/**
 * Get auto-lock timeout preference for an account
 */
export async function getAutoLockTimeout(
	email?: string,
): Promise<number | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
	const stored = await getItem(key);
	return stored ? Number.parseInt(stored, 10) : null;
}

/**
 * Get auto-lock timeout or default value
 */
export async function getAutoLockTimeoutOrDefault(
	email?: string,
): Promise<number> {
	const stored = await getAutoLockTimeout(email);
	return stored ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS;
}

/**
 * Clear auto-lock timeout preference for an account
 */
export async function clearAutoLockTimeout(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
	await deleteItem(key);
}

/**
 * Generate or retrieve device-specific encryption key
 */
async function getDeviceKey(): Promise<Uint8Array> {
	const stored = await getItem(DEVICE_KEY_STORAGE);

	if (stored) {
		return base64ToArrayBuffer(stored);
	}

	// Generate new device key using expo-crypto
	const deviceKey = Crypto.getRandomBytes(32);
	await setItem(DEVICE_KEY_STORAGE, arrayBufferToBase64(deviceKey));
	return deviceKey;
}

// ============================================================================
// Account Management Functions
// ============================================================================

/**
 * Get the currently active account email
 */
export async function getActiveAccountEmail(): Promise<string | null> {
	return await getItem(ACTIVE_ACCOUNT_KEY);
}

/**
 * Set the active account
 */
export async function setActiveAccount(email: string): Promise<void> {
	await setItem(ACTIVE_ACCOUNT_KEY, email.toLowerCase());

	// Update lastActiveAt for this account
	const accountsList = await getAccountsList();
	const account = accountsList.accounts.find(
		(a) => a.email.toLowerCase() === email.toLowerCase(),
	);
	if (account) {
		account.lastActiveAt = Date.now();
		await setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}
}

/**
 * Get list of all accounts
 */
export async function getAccountsList(): Promise<AccountsList> {
	const stored = await getItem(ACCOUNTS_LIST_KEY);
	if (!stored) {
		return { accounts: [] };
	}
	try {
		return JSON.parse(stored) as AccountsList;
	} catch {
		return { accounts: [] };
	}
}

/**
 * Add a new account to the accounts list
 */
export async function addAccountToList(
	metadata: AccountMetadata,
): Promise<void> {
	const accountsList = await getAccountsList();

	// Check if account already exists (by email)
	const existingIndex = accountsList.accounts.findIndex(
		(a) => a.email.toLowerCase() === metadata.email.toLowerCase(),
	);

	if (existingIndex >= 0) {
		// Update existing account
		accountsList.accounts[existingIndex] = metadata;
	} else {
		// Add new account
		accountsList.accounts.push(metadata);
	}

	await setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
}

/**
 * Remove an account from the accounts list
 */
export async function removeAccountFromList(email: string): Promise<void> {
	const accountsList = await getAccountsList();

	accountsList.accounts = accountsList.accounts.filter(
		(a) => a.email.toLowerCase() !== email.toLowerCase(),
	);

	await setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
}

/**
 * Get metadata for a specific account
 */
export async function getAccountMetadata(
	email: string,
): Promise<AccountMetadata | null> {
	const accountsList = await getAccountsList();
	return (
		accountsList.accounts.find(
			(a) => a.email.toLowerCase() === email.toLowerCase(),
		) ?? null
	);
}

/**
 * Helper to get the email to use for storage operations
 */
async function resolveEmail(email?: string): Promise<string | null> {
	if (email) return email.toLowerCase();
	return await getActiveAccountEmail();
}

/**
 * Get or initialize the cache for an account
 */
function getAccountCache(email: string): AccountCache {
	const key = email.toLowerCase();
	let cache = accountCaches.get(key);
	if (!cache) {
		cache = { authToken: null, vaultKeys: null, masterUnlockKey: null };
		accountCaches.set(key, cache);
	}
	return cache;
}

/**
 * Clear the cache for an account
 */
function clearAccountCache(email: string): void {
	accountCaches.delete(email.toLowerCase());
}

// ============================================================================
// Biometric Functions
// ============================================================================

/**
 * Check if biometric authentication is available on this device
 */
export async function isBiometricAvailable(): Promise<boolean> {
	try {
		const hasHardware = await LocalAuthentication.hasHardwareAsync();
		if (!hasHardware) return false;

		const isEnrolled = await LocalAuthentication.isEnrolledAsync();
		return isEnrolled;
	} catch {
		return false;
	}
}

/**
 * Get biometric type available (Face ID, Touch ID, etc.)
 */
export async function getBiometricType(): Promise<string | null> {
	try {
		const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
		if (
			types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
		) {
			return "Face ID";
		}
		if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
			return "Touch ID";
		}
		if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
			return "Iris";
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Check if biometric unlock is enabled by user
 */
export async function isBiometricEnabled(email?: string): Promise<boolean> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return false;

		const key = getAccountKey(resolvedEmail, "biometric_enabled");
		const enabled = await getItem(key);
		return enabled === "true";
	} catch {
		return false;
	}
}

/**
 * Enable biometric unlock
 */
export async function enableBiometric(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "biometric_enabled");
	await setItem(key, "true");
}

/**
 * Disable biometric unlock
 */
export async function disableBiometric(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "biometric_enabled");
	await setItem(key, "false");
}

/**
 * Authenticate using biometric (Face ID / Touch ID)
 * Also updates the last authentication timestamp
 */
export async function authenticateWithBiometric(
	reason = "Unlock Bittery",
	email?: string,
): Promise<boolean> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return false;

		const result = await LocalAuthentication.authenticateAsync({
			promptMessage: reason,
			cancelLabel: "Cancel",
			disableDeviceFallback: false,
			fallbackLabel: "Use Password",
		});

		if (result.success) {
			// Update last biometric auth timestamp
			const key = getAccountKey(resolvedEmail, "last_biometric_auth");
			await setItem(key, Date.now().toString());
			return true;
		}

		return false;
	} catch (error) {
		console.error(
			"[storage-react-native] Biometric authentication failed:",
			error,
		);
		return false;
	}
}

/**
 * Store Secret Key (plaintext - safe because useless without password)
 */
export async function storeSecretKey(
	secretKey: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "secret_key");
	await setItem(key, secretKey);
}

/**
 * Get stored Secret Key
 */
export async function getStoredSecretKey(
	email?: string,
): Promise<string | undefined> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return undefined;

	const key = getAccountKey(resolvedEmail, "secret_key");
	return (await getItem(key)) ?? undefined;
}

/**
 * Check if Secret Key is stored
 */
export async function hasStoredSecretKey(email?: string): Promise<boolean> {
	const secretKey = await getStoredSecretKey(email);
	return secretKey != null;
}

/**
 * Store encrypted session data with expiry
 */
export async function storeSessionData(
	masterUnlockKey: Uint8Array,
	email: string,
	userId: string,
	expiryMs: number = DEFAULT_SESSION_EXPIRY_MS,
): Promise<void> {
	const resolvedEmail = email.toLowerCase();
	const deviceKey = await getDeviceKey();
	const now = Date.now();

	// Encrypt Master Unlock Key with device key
	const mukBase64 = arrayBufferToBase64(masterUnlockKey);
	const encryptedMUK = await encrypt(mukBase64, deviceKey);

	const biometricEnabled = await isBiometricEnabled(resolvedEmail);

	const sessionData: StoredSessionData = {
		encryptedMasterUnlockKey: encryptedMUK,
		email: resolvedEmail,
		userId,
		expiresAt: now + expiryMs,
		createdAt: now,
		biometricEnabled,
		lastMasterPasswordEntry: now, // Record initial master password entry
	};

	const key = getAccountKey(resolvedEmail, "session_data");
	await setItem(key, JSON.stringify(sessionData));
}

/**
 * Get stored session data
 */
export async function getStoredSessionData(
	email?: string,
): Promise<StoredSessionData | null> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "session_data");
		const stored = await getItem(key);

		if (!stored) return null;

		const sessionData: StoredSessionData = JSON.parse(stored);
		return sessionData;
	} catch {
		return null;
	}
}

/**
 * Check if stored session is still valid (not expired)
 */
export async function isSessionValid(email?: string): Promise<boolean> {
	const sessionData = await getStoredSessionData(email);
	if (!sessionData) return false;

	const now = Date.now();
	return now < sessionData.expiresAt;
}

/**
 * Get time until session expires (in milliseconds)
 */
export async function getTimeUntilExpiry(
	email?: string,
): Promise<number | null> {
	const sessionData = await getStoredSessionData(email);
	if (!sessionData) return null;

	const now = Date.now();
	const timeLeft = sessionData.expiresAt - now;
	return timeLeft > 0 ? timeLeft : 0;
}

/**
 * Check if biometric authentication is required based on grace period
 */
export async function isBiometricAuthRequired(
	email?: string,
): Promise<boolean> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return false;

	const sessionData = await getStoredSessionData(resolvedEmail);
	if (!sessionData || !sessionData.biometricEnabled) {
		return false;
	}

	const key = getAccountKey(resolvedEmail, "last_biometric_auth");
	const lastAuthStr = await getItem(key);

	if (!lastAuthStr) {
		return true; // Never authenticated before
	}

	const lastAuth = Number.parseInt(lastAuthStr, 10);
	const timeSinceLastAuth = Date.now() - lastAuth;
	return timeSinceLastAuth > BIOMETRIC_GRACE_PERIOD_MS;
}

/**
 * Check if master password re-entry is required (periodic security measure)
 * Returns true if more than 30 days have passed since last master password entry
 */
export async function isMasterPasswordReentryRequired(
	email?: string,
): Promise<boolean> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return false;

	const sessionData = await getStoredSessionData(resolvedEmail);
	if (!sessionData) return true; // No session, require password

	// If no lastMasterPasswordEntry recorded, check createdAt
	const lastPasswordEntry =
		sessionData.lastMasterPasswordEntry || sessionData.createdAt;
	const timeSinceLastEntry = Date.now() - lastPasswordEntry;

	return timeSinceLastEntry > MASTER_PASSWORD_REENTRY_PERIOD_MS;
}

/**
 * Update the last master password entry timestamp
 */
export async function updateLastMasterPasswordEntry(
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const sessionData = await getStoredSessionData(resolvedEmail);
	if (!sessionData) return;

	sessionData.lastMasterPasswordEntry = Date.now();

	const key = getAccountKey(resolvedEmail, "session_data");
	await setItem(key, JSON.stringify(sessionData));
}

/**
 * Store the timestamp when app went to background
 */
export async function storeBackgroundTimestamp(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	const key = getAccountKey(resolvedEmail, "background_timestamp");
	await setItem(key, Date.now().toString());
}

/**
 * Get the timestamp when app went to background
 */
export async function getBackgroundTimestamp(
	email?: string,
): Promise<number | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const key = getAccountKey(resolvedEmail, "background_timestamp");
	const timestamp = await getItem(key);
	return timestamp ? Number.parseInt(timestamp, 10) : null;
}

/**
 * Clear the background timestamp
 */
export async function clearBackgroundTimestamp(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	const key = getAccountKey(resolvedEmail, "background_timestamp");
	await deleteItem(key);
}

/**
 * Check if app should require re-authentication after returning from background
 */
export async function shouldRequireAuthAfterBackground(
	email?: string,
): Promise<boolean> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return false;

	const backgroundTimestamp = await getBackgroundTimestamp(resolvedEmail);
	if (!backgroundTimestamp) return false;

	const autoLockTimeout = await getAutoLockTimeoutOrDefault(resolvedEmail);

	// If auto-lock is set to "Never" (-1), don't require re-auth
	if (autoLockTimeout === -1) return false;

	const timeSinceBackground = Date.now() - backgroundTimestamp;
	return timeSinceBackground > autoLockTimeout;
}

/**
 * Get detailed biometric availability status
 */
export async function getBiometricAvailabilityDetails(): Promise<{
	hasHardware: boolean;
	isEnrolled: boolean;
	availableTypes: string[];
}> {
	try {
		const hasHardware = await LocalAuthentication.hasHardwareAsync();
		const isEnrolled = await LocalAuthentication.isEnrolledAsync();
		const types =
			await LocalAuthentication.supportedAuthenticationTypesAsync();

		const availableTypes: string[] = [];
		if (
			types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
		) {
			availableTypes.push("Face ID");
		}
		if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
			availableTypes.push("Touch ID");
		}
		if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) {
			availableTypes.push("Iris");
		}

		return { hasHardware, isEnrolled, availableTypes };
	} catch {
		return { hasHardware: false, isEnrolled: false, availableTypes: [] };
	}
}

/**
 * Enhanced biometric authentication with detailed error handling
 */
export async function authenticateWithBiometricEnhanced(
	reason = "Unlock Bittery",
	email?: string,
): Promise<BiometricAuthResult> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) {
			return {
				success: false,
				error: "unknown",
				message: "No account specified",
			};
		}

		// Check hardware availability
		const hasHardware = await LocalAuthentication.hasHardwareAsync();
		if (!hasHardware) {
			return {
				success: false,
				error: "not_available",
				message: "This device does not support biometric authentication",
			};
		}

		// Check if biometrics are enrolled
		const isEnrolled = await LocalAuthentication.isEnrolledAsync();
		if (!isEnrolled) {
			return {
				success: false,
				error: "not_enrolled",
				message:
					"No biometrics enrolled. Please set up Face ID or Touch ID in your device settings",
			};
		}

		// Check if biometric is enabled for this account
		const isEnabled = await isBiometricEnabled(resolvedEmail);
		if (!isEnabled) {
			return {
				success: false,
				error: "not_enabled",
				message: "Biometric authentication is not enabled for this account",
			};
		}

		// Check if master password re-entry is required
		if (await isMasterPasswordReentryRequired(resolvedEmail)) {
			return {
				success: false,
				error: "master_password_required",
				message:
					"For your security, please enter your master password. This is required periodically.",
			};
		}

		// Check if session is valid
		if (!(await isSessionValid(resolvedEmail))) {
			return {
				success: false,
				error: "session_expired",
				message: "Your session has expired. Please log in again",
			};
		}

		const result = await LocalAuthentication.authenticateAsync({
			promptMessage: reason,
			cancelLabel: "Cancel",
			disableDeviceFallback: false,
			fallbackLabel: "Use Password",
		});

		if (result.success) {
			// Update last biometric auth timestamp
			const key = getAccountKey(resolvedEmail, "last_biometric_auth");
			await setItem(key, Date.now().toString());

			// Clear background timestamp on successful auth
			await clearBackgroundTimestamp(resolvedEmail);

			return { success: true };
		}

		// Handle specific error cases
		if (result.error === "user_cancel") {
			return {
				success: false,
				error: "user_cancelled",
				message: "Authentication was cancelled",
			};
		}

		if (result.error === "lockout") {
			return {
				success: false,
				error: "lockout",
				message:
					"Too many failed attempts. Please use your password to unlock",
			};
		}

		return {
			success: false,
			error: "authentication_failed",
			message: "Biometric authentication failed. Please try again",
		};
	} catch (error) {
		console.error(
			"[storage-react-native] Enhanced biometric authentication failed:",
			error,
		);
		return {
			success: false,
			error: "unknown",
			message: "An unexpected error occurred during authentication",
		};
	}
}

/**
 * Get a user-friendly message for a biometric error
 */
export function getBiometricErrorMessage(error: BiometricErrorType): string {
	switch (error) {
		case "not_available":
			return "This device does not support biometric authentication.";
		case "not_enrolled":
			return "No biometrics are set up on this device. Please configure Face ID or Touch ID in your device settings.";
		case "not_enabled":
			return "Biometric unlock is not enabled for this account. You can enable it in Settings.";
		case "authentication_failed":
			return "Biometric authentication failed. Please try again or use your password.";
		case "user_cancelled":
			return "Authentication was cancelled.";
		case "lockout":
			return "Too many failed attempts. Please use your master password to unlock.";
		case "master_password_required":
			return "For security, please enter your master password. This is required every 30 days.";
		case "session_expired":
			return "Your session has expired. Please log in with your credentials.";
		default:
			return "An error occurred during authentication. Please try again.";
	}
}

/**
 * Decrypt Master Unlock Key from stored session
 */
export async function decryptStoredMasterUnlockKey(
	skipBiometric = false,
	email?: string,
): Promise<Uint8Array | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const sessionData = await getStoredSessionData(resolvedEmail);
	if (!sessionData) return null;

	// Check if biometric authentication is required
	if (!skipBiometric && sessionData.biometricEnabled) {
		const authRequired = await isBiometricAuthRequired(resolvedEmail);
		if (authRequired) {
			const authenticated = await authenticateWithBiometric(
				"Unlock your vault",
				resolvedEmail,
			);
			if (!authenticated) {
				return null;
			}
		}
	}

	try {
		const deviceKey = await getDeviceKey();
		const mukBase64 = await decrypt(
			sessionData.encryptedMasterUnlockKey,
			deviceKey,
		);
		return base64ToArrayBuffer(mukBase64);
	} catch {
		return null;
	}
}

/**
 * Clear stored session data (logout) for an account
 */
export async function clearStoredSession(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	await deleteItem(getAccountKey(resolvedEmail, "session_data"));
	await deleteItem(getAccountKey(resolvedEmail, "last_biometric_auth"));
}

/**
 * Clear everything including Secret Key for a specific account
 */
export async function clearAccountData(email: string): Promise<void> {
	const resolvedEmail = email.toLowerCase();

	// Delete all namespaced keys for this account
	await deleteItem(getAccountKey(resolvedEmail, "secret_key"));
	await deleteItem(getAccountKey(resolvedEmail, "session_data"));
	await deleteItem(getAccountKey(resolvedEmail, "jwt_token"));
	await deleteItem(getAccountKey(resolvedEmail, "vault_keys"));
	await deleteItem(getAccountKey(resolvedEmail, "biometric_enabled"));
	await deleteItem(getAccountKey(resolvedEmail, "last_biometric_auth"));
	await deleteItem(getAccountKey(resolvedEmail, "server_url"));
	await deleteItem(getAccountKey(resolvedEmail, "web_app_url"));
	await deleteItem(getAccountKey(resolvedEmail, "encrypted_private_key"));
	await deleteItem(getAccountKey(resolvedEmail, "auto_lock_timeout"));
	await deleteItem(getAccountKey(resolvedEmail, "background_timestamp"));

	// Clear in-memory cache
	clearAccountCache(resolvedEmail);

	// Remove from accounts list
	await removeAccountFromList(resolvedEmail);
}

/**
 * Clear all stored data for active account
 */
export async function clearAllStoredData(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (resolvedEmail) {
		await clearAccountData(resolvedEmail);
	}
}

/**
 * Check if quick unlock is available
 */
export async function canQuickUnlock(email?: string): Promise<boolean> {
	const hasSecretKey = await hasStoredSecretKey(email);
	const sessionValid = await isSessionValid(email);
	return hasSecretKey && sessionValid;
}

/**
 * Check if biometric unlock is available
 */
export async function canBiometricUnlock(email?: string): Promise<boolean> {
	const available = await isBiometricAvailable();
	const enabled = await isBiometricEnabled(email);
	const sessionValid = await isSessionValid(email);
	return available && enabled && sessionValid;
}

/**
 * Store JWT token
 */
export async function storeAuthToken(
	token: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	// Store in account cache
	const cache = getAccountCache(resolvedEmail);
	cache.authToken = token;

	// Also persist to disk
	const key = getAccountKey(resolvedEmail, "jwt_token");
	await setItem(key, token);
}

/**
 * Get JWT token
 */
export async function getAuthToken(email?: string): Promise<string | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	// Check account cache first
	const cache = getAccountCache(resolvedEmail);
	if (cache.authToken) {
		return cache.authToken;
	}

	// Try to restore from disk
	const key = getAccountKey(resolvedEmail, "jwt_token");
	const token = await getItem(key);
	if (token) {
		cache.authToken = token;
	}

	return token;
}

/**
 * Store encrypted vault keys
 */
export async function storeVaultKeys(
	vaultKeys: VaultKeyData[],
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	console.log(
		"[storage-react-native] Storing vault keys:",
		vaultKeys.length,
		"keys",
	);

	// Store in account cache
	const cache = getAccountCache(resolvedEmail);
	cache.vaultKeys = vaultKeys;

	// Also persist to disk
	const key = getAccountKey(resolvedEmail, "vault_keys");
	await setItem(key, JSON.stringify(vaultKeys));
}

/**
 * Get encrypted vault keys
 */
export async function getVaultKeys(
	email?: string,
): Promise<VaultKeyData[] | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	// Check account cache first
	const cache = getAccountCache(resolvedEmail);
	
	if (cache.vaultKeys) {
		return cache.vaultKeys;
	}

	// Try to restore from disk
	const key = getAccountKey(resolvedEmail, "vault_keys");
	const stored = await getItem(key);
	if (stored) {
		cache.vaultKeys = JSON.parse(stored);
	}
	return cache.vaultKeys;
}

/**
 * Store encrypted private key
 */
export async function storeEncryptedPrivateKey(
	encryptedPrivateKey: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const key = getAccountKey(resolvedEmail, "encrypted_private_key");
	await setItem(key, encryptedPrivateKey);
}

/**
 * Get encrypted private key
 */
export async function getEncryptedPrivateKey(
	email?: string,
): Promise<string | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const key = getAccountKey(resolvedEmail, "encrypted_private_key");
	return await getItem(key);
}

/**
 * Store Master Unlock Key in memory cache
 */
export async function storeMasterUnlockKey(
	key: Uint8Array,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const cache = getAccountCache(resolvedEmail);
	cache.masterUnlockKey = key;
}

/**
 * Get Master Unlock Key from memory cache
 */
export async function getMasterUnlockKey(
	email?: string,
): Promise<Uint8Array | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	// Return from account cache if available
	const cache = getAccountCache(resolvedEmail);
	if (cache.masterUnlockKey) {
		return cache.masterUnlockKey;
	}

	// Try to restore from persistent storage if session is still valid
	if (await isSessionValid(resolvedEmail)) {
		const restored = await decryptStoredMasterUnlockKey(false, resolvedEmail);
		if (restored) {
			cache.masterUnlockKey = restored;
			return restored;
		}
	}

	return null;
}

/**
 * Check if an encrypted vault key is AES-GCM or RSA encrypted
 */
function isAesEncryptedVaultKey(encryptedVaultKey: string): boolean {
	try {
		const parsed = JSON.parse(encryptedVaultKey);
		return (
			parsed &&
			typeof parsed.ciphertext === "string" &&
			typeof parsed.iv === "string"
		);
	} catch {
		return false;
	}
}

/**
 * Decrypt a vault key
 */
export async function decryptVaultKey(
	encryptedVaultKey: string,
	email?: string,
): Promise<Uint8Array> {
	const masterUnlockKey = await getMasterUnlockKey(email);
	if (!masterUnlockKey) {
		throw new Error("Master Unlock Key not available. Please log in again.");
	}

	if (isAesEncryptedVaultKey(encryptedVaultKey)) {
		// AES-GCM encrypted (owner's vault key)
		const encryptedData: EncryptedData = JSON.parse(encryptedVaultKey);
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const decryptedBase64 = await decrypt(
			encryptedData,
			base64ToArrayBuffer(mukBase64),
		);
		return base64ToArrayBuffer(decryptedBase64);
	}

	// RSA encrypted (shared vault key)
	const encryptedPrivateKey = await getEncryptedPrivateKey(email);
	if (!encryptedPrivateKey) {
		throw new Error(
			"Encrypted private key not available. Please log in again.",
		);
	}

	const privateKeyEncryptedData: EncryptedData =
		JSON.parse(encryptedPrivateKey);
	const mukBase64 = arrayBufferToBase64(masterUnlockKey);
	const privateKeyPEM = await decrypt(
		privateKeyEncryptedData,
		base64ToArrayBuffer(mukBase64),
	);

	const vaultKeyBase64 = await rsaDecrypt(encryptedVaultKey, privateKeyPEM);
	return base64ToArrayBuffer(vaultKeyBase64);
}

/**
 * Get decrypted vault key for a specific vault
 */
export async function getDecryptedVaultKey(
	vaultId: string,
	email?: string,
): Promise<Uint8Array | null> {
	const vaultKeys = await getVaultKeys(email);
	if (!vaultKeys) return null;

	const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
	if (!vaultKeyData) return null;

	return decryptVaultKey(vaultKeyData.encryptedVaultKey, email);
}

/**
 * Clear all session data (logout)
 */
export async function clearSession(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	clearAccountCache(resolvedEmail);
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(email?: string): Promise<boolean> {
	const token = await getAuthToken(email);
	return token != null;
}

/**
 * Try to restore Master Unlock Key from stored session
 */
export async function tryRestoreSession(
	skipBiometric = false,
	email?: string,
): Promise<boolean> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return false;

	if (!(await isSessionValid(resolvedEmail))) {
		return false;
	}

	const masterUnlockKey = await decryptStoredMasterUnlockKey(
		skipBiometric,
		resolvedEmail,
	);

	if (!masterUnlockKey) {
		return false;
	}

	await storeMasterUnlockKey(masterUnlockKey, resolvedEmail);
	return true;
}

/**
 * Unlock with biometric authentication
 */
export async function unlockWithBiometric(email?: string): Promise<boolean> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return false;

		if (!(await canBiometricUnlock(resolvedEmail))) {
			return false;
		}

		const masterUnlockKey = await decryptStoredMasterUnlockKey(
			false,
			resolvedEmail,
		);
		if (!masterUnlockKey) {
			return false;
		}

		await storeMasterUnlockKey(masterUnlockKey, resolvedEmail);
		return true;
	} catch (error) {
		console.error("[storage-react-native] Biometric unlock failed:", error);
		return false;
	}
}

/**
 * Lock all accounts (clear all in-memory caches)
 */
export function lockAllAccounts(): void {
	accountCaches.clear();
}

// ============================================================================
// Generic Storage Functions (for offline cache)
// ============================================================================

/**
 * Generic key-value storage - set item
 * Note: For offline cache data that doesn't need account scoping
 */
export async function setOfflineCacheItem(
	key: string,
	value: string,
): Promise<void> {
	await setItem(key, value);
}

/**
 * Generic key-value storage - get item
 * Note: For offline cache data that doesn't need account scoping
 */
export async function getOfflineCacheItem(key: string): Promise<string | null> {
	return getItem(key);
}

/**
 * Generic key-value storage - delete item
 * Note: For offline cache data that doesn't need account scoping
 */
export async function deleteOfflineCacheItem(key: string): Promise<void> {
	await deleteItem(key);
}
