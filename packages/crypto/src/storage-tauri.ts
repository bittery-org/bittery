/**
 * Tauri Desktop Storage Adapter with Biometric Authentication
 * Adapts session-storage.ts to use Tauri's secure storage APIs with Touch ID/Windows Hello
 */

import {
	authenticate,
	checkStatus,
} from "@choochmeque/tauri-plugin-biometry-api";
import { Store } from "@tauri-apps/plugin-store";
import { decrypt, type EncryptedData, encrypt } from "./encryption";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./key-derivation";
import { rsaDecrypt } from "./rsa";

// Legacy storage keys (single-account format - used for migration detection)
const LEGACY_SECRET_KEY_STORAGE = "bittery_secret_key";
const LEGACY_SESSION_DATA_STORAGE = "bittery_session_data";
const LEGACY_JWT_TOKEN_KEY = "bittery_jwt_token";
const LEGACY_VAULT_KEYS_KEY = "bittery_vault_keys";
const LEGACY_BIOMETRIC_ENABLED_KEY = "bittery_biometric_enabled";
const LEGACY_LAST_BIOMETRIC_AUTH_KEY = "bittery_last_biometric_auth";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_STORAGE = "bittery_device_key";
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";
const MIGRATION_COMPLETED_KEY = "bittery_migration_v2_completed";
const SERVER_URL_STORAGE = "bittery_server_url";

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

export interface StoredSessionData {
	encryptedMasterUnlockKey: EncryptedData;
	email: string;
	userId: string;
	expiresAt: number; // timestamp
	createdAt: number; // timestamp
	biometricEnabled?: boolean;
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

// Store instance (lazy initialized)
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
	if (!storeInstance) {
		storeInstance = await Store.load("store.json");
	}
	return storeInstance;
}

// ============================================================================
// Server URL Functions
// ============================================================================

export async function storeServerUrl(serverUrl: string): Promise<void> {
	const store = await getStore();
	await store.set(SERVER_URL_STORAGE, serverUrl);
	await store.save();
}

export async function getServerUrl(): Promise<string | null> {
	const store = await getStore();
	return (await store.get<string>(SERVER_URL_STORAGE)) ?? null;
}

export async function clearServerUrl(): Promise<void> {
	const store = await getStore();
	await store.delete(SERVER_URL_STORAGE);
	await store.save();
}

/**
 * Generate or retrieve device-specific encryption key
 * This key is used to encrypt the Master Unlock Key at rest
 */
async function getDeviceKey(): Promise<Uint8Array> {
	const store = await getStore();
	const stored = await store.get<string>(DEVICE_KEY_STORAGE);

	if (stored) {
		return base64ToArrayBuffer(stored);
	}

	// Generate new device key
	const deviceKey = crypto.getRandomValues(new Uint8Array(32));
	await store.set(DEVICE_KEY_STORAGE, arrayBufferToBase64(deviceKey));
	await store.save();
	return deviceKey;
}

// ============================================================================
// Account Management Functions
// ============================================================================

/**
 * Get the currently active account email
 */
export async function getActiveAccountEmail(): Promise<string | null> {
	const store = await getStore();
	return (await store.get<string>(ACTIVE_ACCOUNT_KEY)) ?? null;
}

/**
 * Set the active account
 */
export async function setActiveAccount(email: string): Promise<void> {
	const store = await getStore();
	await store.set(ACTIVE_ACCOUNT_KEY, email.toLowerCase());
	await store.save();

	// Update lastActiveAt for this account
	const accountsList = await getAccountsList();
	const account = accountsList.accounts.find(
		(a) => a.email.toLowerCase() === email.toLowerCase(),
	);
	if (account) {
		account.lastActiveAt = Date.now();
		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		await store.save();
	}
}

/**
 * Get list of all accounts
 */
export async function getAccountsList(): Promise<AccountsList> {
	const store = await getStore();
	const stored = await store.get<string>(ACCOUNTS_LIST_KEY);
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
	const store = await getStore();
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

	await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	await store.save();
}

/**
 * Remove an account from the accounts list
 */
export async function removeAccountFromList(email: string): Promise<void> {
	const store = await getStore();
	const accountsList = await getAccountsList();

	accountsList.accounts = accountsList.accounts.filter(
		(a) => a.email.toLowerCase() !== email.toLowerCase(),
	);

	await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	await store.save();
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
 * If no email provided, uses active account
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
		const status = await checkStatus();
		return status.isAvailable;
	} catch {
		return false;
	}
}

/**
 * Check if biometric unlock is enabled by user
 */
export async function isBiometricEnabled(email?: string): Promise<boolean> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return false;

		const store = await getStore();
		const key = getAccountKey(resolvedEmail, "biometric_enabled");
		const enabled = await store.get<boolean>(key);
		return enabled === true;
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

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "biometric_enabled");
	await store.set(key, true);
	await store.save();
}

/**
 * Disable biometric unlock
 */
export async function disableBiometric(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "biometric_enabled");
	await store.set(key, false);
	await store.save();
}

/**
 * Authenticate using biometric (Touch ID / Windows Hello)
 * Also updates the last authentication timestamp
 */
export async function authenticateWithBiometric(
	reason = "Unlock Bittery",
	email?: string,
): Promise<boolean> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return false;

		await authenticate(reason);
		// Update last biometric auth timestamp
		const store = await getStore();
		const key = getAccountKey(resolvedEmail, "last_biometric_auth");
		await store.set(key, Date.now());
		await store.save();
		return true;
	} catch (error) {
		console.error("[storage-tauri] Biometric authentication failed:", error);
		return false;
	}
}

/**
 * Store Secret Key in Tauri secure storage (plaintext - safe because useless without password)
 */
export async function storeSecretKey(
	secretKey: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "secret_key");
	await store.set(key, secretKey);
	await store.save();
}

/**
 * Get stored Secret Key
 */
export async function getStoredSecretKey(
	email?: string,
): Promise<string | undefined> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return undefined;

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "secret_key");
	return await store.get<string>(key);
}

/**
 * Check if Secret Key is stored (user has logged in on this device before)
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
	const store = await getStore();
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
	};

	const key = getAccountKey(resolvedEmail, "session_data");
	await store.set(key, JSON.stringify(sessionData));
	await store.save();
}

/**
 * Get stored session data and check if it's still valid
 */
export async function getStoredSessionData(
	email?: string,
): Promise<StoredSessionData | null> {
	try {
		const resolvedEmail = await resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await getStore();
		const key = getAccountKey(resolvedEmail, "session_data");
		const stored = await store.get<string>(key);

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

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "last_biometric_auth");
	const lastAuth = await store.get<number>(key);

	if (!lastAuth) {
		return true; // Never authenticated before
	}

	const timeSinceLastAuth = Date.now() - lastAuth;
	return timeSinceLastAuth > BIOMETRIC_GRACE_PERIOD_MS;
}

/**
 * Decrypt Master Unlock Key from stored session
 * If biometric is enabled, requires biometric authentication (with grace period)
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
 * Clear all stored session data (logout) for an account
 */
export async function clearStoredSession(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	const store = await getStore();
	await store.delete(getAccountKey(resolvedEmail, "session_data"));
	await store.delete(getAccountKey(resolvedEmail, "last_biometric_auth"));
	await store.save();
}

/**
 * Clear everything including Secret Key (complete logout from device) for a specific account
 */
export async function clearAccountData(email: string): Promise<void> {
	const resolvedEmail = email.toLowerCase();
	const store = await getStore();

	// Delete all namespaced keys for this account
	await store.delete(getAccountKey(resolvedEmail, "secret_key"));
	await store.delete(getAccountKey(resolvedEmail, "session_data"));
	await store.delete(getAccountKey(resolvedEmail, "jwt_token"));
	await store.delete(getAccountKey(resolvedEmail, "vault_keys"));
	await store.delete(getAccountKey(resolvedEmail, "biometric_enabled"));
	await store.delete(getAccountKey(resolvedEmail, "last_biometric_auth"));
	await store.save();

	// Clear in-memory cache
	clearAccountCache(resolvedEmail);

	// Remove from accounts list
	await removeAccountFromList(resolvedEmail);
}

/**
 * Clear everything including Secret Key (complete logout from device)
 * This clears the active account's data
 */
export async function clearAllStoredData(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (resolvedEmail) {
		await clearAccountData(resolvedEmail);
	}
}

/**
 * Check if quick unlock is available
 * Requires: stored secret key + valid session
 */
export async function canQuickUnlock(email?: string): Promise<boolean> {
	const hasSecretKey = await hasStoredSecretKey(email);
	const sessionValid = await isSessionValid(email);
	return hasSecretKey && sessionValid;
}

/**
 * Check if biometric unlock is available
 * Requires: biometric hardware + enabled by user + valid session
 */
export async function canBiometricUnlock(email?: string): Promise<boolean> {
	const available = await isBiometricAvailable();
	const enabled = await isBiometricEnabled(email);
	const sessionValid = await isSessionValid(email);
	return available && enabled && sessionValid;
}

/**
 * Store JWT token in memory (session storage)
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

	// Also persist to disk for session restoration
	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "jwt_token");
	await store.set(key, token);
	await store.save();
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
	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "jwt_token");
	const token = await store.get<string>(key);
	if (token) {
		cache.authToken = token;
	}

	return token ?? null;
}

/**
 * Store encrypted vault keys in memory
 */
export async function storeVaultKeys(
	vaultKeys: VaultKeyData[],
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	console.log("[storage-tauri] Storing vault keys:", vaultKeys.length, "keys");

	// Store in account cache
	const cache = getAccountCache(resolvedEmail);
	cache.vaultKeys = vaultKeys;

	// Also persist to disk for session restoration
	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "vault_keys");
	await store.set(key, JSON.stringify(vaultKeys));
	await store.save();
	console.log("[storage-tauri] Vault keys stored successfully");
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
	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "vault_keys");
	const stored = await store.get<string>(key);
	if (stored) {
		cache.vaultKeys = JSON.parse(stored);
	}
	return cache.vaultKeys;
}

/**
 * Store encrypted private key
 * This is needed to decrypt vault keys that were shared via RSA encryption
 */
export async function storeEncryptedPrivateKey(
	encryptedPrivateKey: string,
	email?: string,
): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) throw new Error("No account specified");

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "encrypted_private_key");
	await store.set(key, encryptedPrivateKey);
	await store.save();
}

/**
 * Get encrypted private key
 */
export async function getEncryptedPrivateKey(
	email?: string,
): Promise<string | null> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return null;

	const store = await getStore();
	const key = getAccountKey(resolvedEmail, "encrypted_private_key");
	return (await store.get<string>(key)) ?? null;
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
 * If not in memory but session is valid, restore from encrypted storage
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
 * Check if an encrypted vault key is AES-GCM encrypted (JSON format) or RSA encrypted (plain base64)
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
		// Not valid JSON, so it's RSA encrypted (plain base64)
		return false;
	}
}

/**
 * Decrypt a vault key
 * - For owner vaults: decrypted with AES-GCM using Master Unlock Key
 * - For shared vaults: decrypted with RSA using the user's private key
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
	// First, decrypt the user's private key
	const encryptedPrivateKey = await getEncryptedPrivateKey(email);
	if (!encryptedPrivateKey) {
		throw new Error(
			"Encrypted private key not available. Please log in again.",
		);
	}

	// The private key is encrypted with AES-GCM using Master Unlock Key
	const privateKeyEncryptedData: EncryptedData =
		JSON.parse(encryptedPrivateKey);
	const mukBase64 = arrayBufferToBase64(masterUnlockKey);
	const privateKeyPEM = await decrypt(
		privateKeyEncryptedData,
		base64ToArrayBuffer(mukBase64),
	);

	// Use the decrypted private key to RSA-decrypt the vault key
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
 * Note: This keeps the Secret Key AND session data for quick unlock next time
 * Use clearAllStoredData() to remove everything including Secret Key
 */
export async function clearSession(email?: string): Promise<void> {
	const resolvedEmail = await resolveEmail(email);
	if (!resolvedEmail) return;

	// Clear in-memory cache for this account
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
 * Returns true if successfully restored, false if session expired or unavailable
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
 * This is the main entry point for biometric unlock flow
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
		console.error("[storage-tauri] Biometric unlock failed:", error);
		return false;
	}
}

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate from single-account storage format to multi-account format
 * This runs on app startup and handles existing users seamlessly
 */
export async function migrateToMultiAccount(): Promise<void> {
	const store = await getStore();

	// Check if migration already completed
	const migrationCompleted = await store.get<boolean>(MIGRATION_COMPLETED_KEY);
	if (migrationCompleted) {
		return;
	}

	// Check if there's legacy data to migrate
	const legacySessionData = await store.get<string>(
		LEGACY_SESSION_DATA_STORAGE,
	);
	if (!legacySessionData) {
		// No legacy data, mark migration as complete
		await store.set(MIGRATION_COMPLETED_KEY, true);
		await store.save();
		return;
	}

	try {
		const sessionData: StoredSessionData = JSON.parse(legacySessionData);
		const email = sessionData.email.toLowerCase();

		console.log("[storage-tauri] Migrating legacy account:", email);

		// Migrate all legacy keys to namespaced format
		const legacySecretKey = await store.get<string>(LEGACY_SECRET_KEY_STORAGE);
		const legacyJwtToken = await store.get<string>(LEGACY_JWT_TOKEN_KEY);
		const legacyVaultKeys = await store.get<string>(LEGACY_VAULT_KEYS_KEY);
		const legacyBiometricEnabled = await store.get<boolean>(
			LEGACY_BIOMETRIC_ENABLED_KEY,
		);
		const legacyLastBiometricAuth = await store.get<number>(
			LEGACY_LAST_BIOMETRIC_AUTH_KEY,
		);

		// Store in new namespaced format
		if (legacySecretKey) {
			await store.set(getAccountKey(email, "secret_key"), legacySecretKey);
		}
		await store.set(getAccountKey(email, "session_data"), legacySessionData);
		if (legacyJwtToken) {
			await store.set(getAccountKey(email, "jwt_token"), legacyJwtToken);
		}
		if (legacyVaultKeys) {
			await store.set(getAccountKey(email, "vault_keys"), legacyVaultKeys);
		}
		if (legacyBiometricEnabled !== undefined) {
			await store.set(
				getAccountKey(email, "biometric_enabled"),
				legacyBiometricEnabled,
			);
		}
		if (legacyLastBiometricAuth !== undefined) {
			await store.set(
				getAccountKey(email, "last_biometric_auth"),
				legacyLastBiometricAuth,
			);
		}

		// Create account metadata
		const secretKeyHint = legacySecretKey
			? `${legacySecretKey.substring(0, 5)}...`
			: "";

		const accountMetadata: AccountMetadata = {
			email,
			userId: sessionData.userId,
			name: email.split("@")[0], // Use email prefix as name initially
			secretKeyHint,
			addedAt: sessionData.createdAt,
			lastActiveAt: Date.now(),
			biometricEnabled: sessionData.biometricEnabled ?? false,
		};

		// Create accounts list
		const accountsList: AccountsList = {
			accounts: [accountMetadata],
		};
		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));

		// Set as active account
		await store.set(ACTIVE_ACCOUNT_KEY, email);

		// Clean up legacy keys
		await store.delete(LEGACY_SECRET_KEY_STORAGE);
		await store.delete(LEGACY_SESSION_DATA_STORAGE);
		await store.delete(LEGACY_JWT_TOKEN_KEY);
		await store.delete(LEGACY_VAULT_KEYS_KEY);
		await store.delete(LEGACY_BIOMETRIC_ENABLED_KEY);
		await store.delete(LEGACY_LAST_BIOMETRIC_AUTH_KEY);

		// Mark migration as complete
		await store.set(MIGRATION_COMPLETED_KEY, true);
		await store.save();

		console.log("[storage-tauri] Migration completed successfully");
	} catch (error) {
		console.error("[storage-tauri] Migration failed:", error);
		// Don't mark as complete so it can be retried
	}
}

/**
 * Lock all accounts (clear all in-memory caches)
 */
export function lockAllAccounts(): void {
	accountCaches.clear();
}
