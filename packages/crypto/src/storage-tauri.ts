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

// Storage keys
const SECRET_KEY_STORAGE = "bittery_secret_key";
const SESSION_DATA_STORAGE = "bittery_session_data";
const DEVICE_KEY_STORAGE = "bittery_device_key";
const JWT_TOKEN_KEY = "bittery_jwt_token";
const VAULT_KEYS_KEY = "bittery_vault_keys";
const BIOMETRIC_ENABLED_KEY = "bittery_biometric_enabled";
const LAST_BIOMETRIC_AUTH_KEY = "bittery_last_biometric_auth";

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
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

// Store instance (lazy initialized)
let storeInstance: Store | null = null;

async function getStore(): Promise<Store> {
	if (!storeInstance) {
		storeInstance = await Store.load("store.json");
	}
	return storeInstance;
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
export async function isBiometricEnabled(): Promise<boolean> {
	try {
		const store = await getStore();
		const enabled = await store.get<boolean>(BIOMETRIC_ENABLED_KEY);
		return enabled === true;
	} catch {
		return false;
	}
}

/**
 * Enable biometric unlock
 */
export async function enableBiometric(): Promise<void> {
	const store = await getStore();
	await store.set(BIOMETRIC_ENABLED_KEY, true);
	await store.save();
}

/**
 * Disable biometric unlock
 */
export async function disableBiometric(): Promise<void> {
	const store = await getStore();
	await store.set(BIOMETRIC_ENABLED_KEY, false);
	await store.save();
}

/**
 * Authenticate using biometric (Touch ID / Windows Hello)
 * Also updates the last authentication timestamp
 */
export async function authenticateWithBiometric(
	reason = "Unlock Bittery",
): Promise<boolean> {
	try {
		await authenticate(reason);
		// Update last biometric auth timestamp
		const store = await getStore();
		await store.set(LAST_BIOMETRIC_AUTH_KEY, Date.now());
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
export async function storeSecretKey(secretKey: string): Promise<void> {
	const store = await getStore();
	await store.set(SECRET_KEY_STORAGE, secretKey);
	await store.save();
}

/**
 * Get stored Secret Key
 */
export async function getStoredSecretKey(): Promise<string | undefined> {
	const store = await getStore();
	return await store.get<string>(SECRET_KEY_STORAGE);
}

/**
 * Check if Secret Key is stored (user has logged in on this device before)
 */
export async function hasStoredSecretKey(): Promise<boolean> {
	const secretKey = await getStoredSecretKey();
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
	const store = await getStore();
	const deviceKey = await getDeviceKey();
	const now = Date.now();

	// Encrypt Master Unlock Key with device key
	const mukBase64 = arrayBufferToBase64(masterUnlockKey);
	const encryptedMUK = await encrypt(mukBase64, deviceKey);

	const biometricEnabled = await isBiometricEnabled();

	const sessionData: StoredSessionData = {
		encryptedMasterUnlockKey: encryptedMUK,
		email,
		userId,
		expiresAt: now + expiryMs,
		createdAt: now,
		biometricEnabled,
	};

	await store.set(SESSION_DATA_STORAGE, JSON.stringify(sessionData));
	await store.save();
}

/**
 * Get stored session data and check if it's still valid
 */
export async function getStoredSessionData(): Promise<StoredSessionData | null> {
	try {
		const store = await getStore();
		const stored = await store.get<string>(SESSION_DATA_STORAGE);

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
export async function isSessionValid(): Promise<boolean> {
	const sessionData = await getStoredSessionData();
	if (!sessionData) return false;

	const now = Date.now();
	return now < sessionData.expiresAt;
}

/**
 * Get time until session expires (in milliseconds)
 */
export async function getTimeUntilExpiry(): Promise<number | null> {
	const sessionData = await getStoredSessionData();
	if (!sessionData) return null;

	const now = Date.now();
	const timeLeft = sessionData.expiresAt - now;
	return timeLeft > 0 ? timeLeft : 0;
}

/**
 * Check if biometric authentication is required based on grace period
 */
export async function isBiometricAuthRequired(): Promise<boolean> {
	const sessionData = await getStoredSessionData();
	if (!sessionData || !sessionData.biometricEnabled) {
		return false;
	}

	const store = await getStore();
	const lastAuth = await store.get<number>(LAST_BIOMETRIC_AUTH_KEY);

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
): Promise<Uint8Array | null> {
	const sessionData = await getStoredSessionData();
	if (!sessionData) return null;

	// Check if biometric authentication is required
	if (!skipBiometric && sessionData.biometricEnabled) {
		const authRequired = await isBiometricAuthRequired();
		if (authRequired) {
			const authenticated =
				await authenticateWithBiometric("Unlock your vault");
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
 * Clear all stored session data (logout)
 */
export async function clearStoredSession(): Promise<void> {
	const store = await getStore();
	await store.delete(SESSION_DATA_STORAGE);
	await store.delete(LAST_BIOMETRIC_AUTH_KEY);
}

/**
 * Clear everything including Secret Key (complete logout from device)
 */
export async function clearAllStoredData(): Promise<void> {
	const store = await getStore();
	await store.delete(SECRET_KEY_STORAGE);
	await store.delete(SESSION_DATA_STORAGE);
	await store.delete(DEVICE_KEY_STORAGE);
	await store.delete(JWT_TOKEN_KEY);
	await store.delete(VAULT_KEYS_KEY);
	await store.delete(BIOMETRIC_ENABLED_KEY);
	await store.delete(LAST_BIOMETRIC_AUTH_KEY);
}

/**
 * Check if quick unlock is available
 * Requires: stored secret key + valid session
 */
export async function canQuickUnlock(): Promise<boolean> {
	const hasSecretKey = await hasStoredSecretKey();
	const sessionValid = await isSessionValid();
	return hasSecretKey && sessionValid;
}

/**
 * Check if biometric unlock is available
 * Requires: biometric hardware + enabled by user + valid session
 */
export async function canBiometricUnlock(): Promise<boolean> {
	const available = await isBiometricAvailable();
	const enabled = await isBiometricEnabled();
	const sessionValid = await isSessionValid();
	return available && enabled && sessionValid;
}

/**
 * Store JWT token in memory (session storage)
 */
let authTokenCache: string | null = null;

export async function storeAuthToken(token: string): Promise<void> {
	authTokenCache = token;
	// Also persist to disk for session restoration
	const store = await getStore();
	await store.set(JWT_TOKEN_KEY, token);
	await store.save();
}

/**
 * Get JWT token
 */
export async function getAuthToken(): Promise<string | null> {
	if (authTokenCache) {
		return authTokenCache;
	}

	// Try to restore from disk
	const store = await getStore();
	const token = await store.get<string>(JWT_TOKEN_KEY);
	if (token) {
		authTokenCache = token;
	}

	return token ?? null;
}

/**
 * Store encrypted vault keys in memory
 */
let vaultKeysCache: VaultKeyData[] | null = null;

export async function storeVaultKeys(vaultKeys: VaultKeyData[]): Promise<void> {
	console.log("[storage-tauri] Storing vault keys:", vaultKeys.length, "keys");
	vaultKeysCache = vaultKeys;

	// Also persist to disk for session restoration
	const store = await getStore();
	await store.set(VAULT_KEYS_KEY, JSON.stringify(vaultKeys));
	await store.save();
	console.log("[storage-tauri] Vault keys stored successfully");
}

/**
 * Get encrypted vault keys
 */
export async function getVaultKeys(): Promise<VaultKeyData[] | null> {
	if (vaultKeysCache) {
		return vaultKeysCache;
	}

	// Try to restore from disk
	const store = await getStore();
	const stored = await store.get<string>(VAULT_KEYS_KEY);
	if (stored) {
		vaultKeysCache = JSON.parse(stored);
	}
	return vaultKeysCache;
}

/**
 * Store Master Unlock Key in memory cache
 */
let masterUnlockKeyCache: Uint8Array | null = null;

export function storeMasterUnlockKey(key: Uint8Array): void {
	masterUnlockKeyCache = key;
}

/**
 * Get Master Unlock Key from memory cache
 * If not in memory but session is valid, restore from encrypted storage
 */
export async function getMasterUnlockKey(): Promise<Uint8Array | null> {
	// Return from memory cache if available
	if (masterUnlockKeyCache) {
		return masterUnlockKeyCache;
	}

	// Try to restore from persistent storage if session is still valid
	if (await isSessionValid()) {
		const restored = await decryptStoredMasterUnlockKey();
		if (restored) {
			masterUnlockKeyCache = restored;
			return restored;
		}
	}

	return null;
}

/**
 * Decrypt a vault key using the Master Unlock Key
 */
export async function decryptVaultKey(
	encryptedVaultKey: string,
): Promise<Uint8Array> {
	const masterUnlockKey = await getMasterUnlockKey();
	if (!masterUnlockKey) {
		throw new Error("Master Unlock Key not available. Please log in again.");
	}

	const encryptedData: EncryptedData = JSON.parse(encryptedVaultKey);
	const mukBase64 = arrayBufferToBase64(masterUnlockKey);
	const decryptedBase64 = await decrypt(
		encryptedData,
		base64ToArrayBuffer(mukBase64),
	);
	return base64ToArrayBuffer(decryptedBase64);
}

/**
 * Get decrypted vault key for a specific vault
 */
export async function getDecryptedVaultKey(
	vaultId: string,
): Promise<Uint8Array | null> {
	const vaultKeys = await getVaultKeys();
	if (!vaultKeys) return null;

	const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
	if (!vaultKeyData) return null;

	return decryptVaultKey(vaultKeyData.encryptedVaultKey);
}

/**
 * Clear all session data (logout)
 * Note: This keeps the Secret Key AND session data for quick unlock next time
 * Use clearAllStoredData() to remove everything including Secret Key
 */
export async function clearSession(): Promise<void> {
	// Only clear in-memory caches, keep persistent storage for unlock
	authTokenCache = null;
	vaultKeysCache = null;
	masterUnlockKeyCache = null;
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
	const token = await getAuthToken();
	return token != null;
}

/**
 * Try to restore Master Unlock Key from stored session
 * Returns true if successfully restored, false if session expired or unavailable
 */
export async function tryRestoreSession(
	skipBiometric = false,
): Promise<boolean> {
	if (!(await isSessionValid())) {
		return false;
	}

	const masterUnlockKey = await decryptStoredMasterUnlockKey(skipBiometric);

	if (!masterUnlockKey) {
		return false;
	}

	storeMasterUnlockKey(masterUnlockKey);
	return true;
}

/**
 * Unlock with biometric authentication
 * This is the main entry point for biometric unlock flow
 */
export async function unlockWithBiometric(): Promise<boolean> {
	try {
		if (!(await canBiometricUnlock())) {
			return false;
		}

		const masterUnlockKey = await decryptStoredMasterUnlockKey(false);
		if (!masterUnlockKey) {
			return false;
		}

		storeMasterUnlockKey(masterUnlockKey);
		return true;
	} catch (error) {
		console.error("[storage-tauri] Biometric unlock failed:", error);
		return false;
	}
}
