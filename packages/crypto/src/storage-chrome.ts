/**
 * Chrome Extension Storage Adapter
 * Adapts session-storage.ts to use chrome.storage APIs instead of localStorage/sessionStorage
 */

import { decrypt, type EncryptedData, encrypt } from "./encryption";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./key-derivation";

// Storage keys
const SECRET_KEY_STORAGE = "bittery_secret_key";
const SESSION_DATA_STORAGE = "bittery_session_data";
const DEVICE_KEY_STORAGE = "bittery_device_key";
const JWT_TOKEN_KEY = "bittery_jwt_token";
const VAULT_KEYS_KEY = "bittery_vault_keys";

// Default session expiry: 14 days (in milliseconds)
export const DEFAULT_SESSION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

export interface StoredSessionData {
	encryptedMasterUnlockKey: EncryptedData;
	email: string;
	userId: string;
	expiresAt: number; // timestamp
	createdAt: number; // timestamp
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

/**
 * Generate or retrieve device-specific encryption key
 * This key is used to encrypt the Master Unlock Key at rest
 */
async function getDeviceKey(): Promise<Uint8Array> {
	const result = await chrome.storage.local.get(DEVICE_KEY_STORAGE);
	const stored = result[DEVICE_KEY_STORAGE];

	if (stored) {
		return base64ToArrayBuffer(stored);
	}

	// Generate new device key
	const deviceKey = crypto.getRandomValues(new Uint8Array(32));
	await chrome.storage.local.set({
		[DEVICE_KEY_STORAGE]: arrayBufferToBase64(deviceKey),
	});
	return deviceKey;
}

/**
 * Store Secret Key in chrome.storage.local (plaintext - safe because useless without password)
 */
export async function storeSecretKey(secretKey: string): Promise<void> {
	await chrome.storage.local.set({ [SECRET_KEY_STORAGE]: secretKey });
}

/**
 * Get stored Secret Key
 */
export async function getStoredSecretKey(): Promise<string | null> {
	const result = await chrome.storage.local.get(SECRET_KEY_STORAGE);
	return result[SECRET_KEY_STORAGE] || null;
}

/**
 * Check if Secret Key is stored (user has logged in on this device before)
 */
export async function hasStoredSecretKey(): Promise<boolean> {
	const secretKey = await getStoredSecretKey();
	return secretKey !== null;
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
	const deviceKey = await getDeviceKey();
	const now = Date.now();

	// Encrypt Master Unlock Key with device key
	const mukBase64 = arrayBufferToBase64(masterUnlockKey);
	const encryptedMUK = await encrypt(mukBase64, deviceKey);

	const sessionData: StoredSessionData = {
		encryptedMasterUnlockKey: encryptedMUK,
		email,
		userId,
		expiresAt: now + expiryMs,
		createdAt: now,
	};

	await chrome.storage.local.set({
		[SESSION_DATA_STORAGE]: JSON.stringify(sessionData),
	});
}

/**
 * Get stored session data and check if it's still valid
 */
export async function getStoredSessionData(): Promise<StoredSessionData | null> {
	const result = await chrome.storage.local.get(SESSION_DATA_STORAGE);
	const stored = result[SESSION_DATA_STORAGE];

	if (!stored) return null;

	try {
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
 * Decrypt Master Unlock Key from stored session
 */
export async function decryptStoredMasterUnlockKey(): Promise<Uint8Array | null> {
	const sessionData = await getStoredSessionData();
	if (!sessionData) return null;

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
	await chrome.storage.local.remove(SESSION_DATA_STORAGE);
}

/**
 * Clear everything including Secret Key (complete logout from device)
 */
export async function clearAllStoredData(): Promise<void> {
	await chrome.storage.local.remove([
		SECRET_KEY_STORAGE,
		SESSION_DATA_STORAGE,
		DEVICE_KEY_STORAGE,
	]);
	await chrome.storage.session.clear();
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
 * Store JWT token in chrome.storage.session
 */
export async function storeAuthToken(token: string): Promise<void> {
	await chrome.storage.session.set({ [JWT_TOKEN_KEY]: token });
}

/**
 * Get JWT token from chrome.storage.session
 */
export async function getAuthToken(): Promise<string | null> {
	const result = await chrome.storage.session.get(JWT_TOKEN_KEY);
	return result[JWT_TOKEN_KEY] || null;
}

/**
 * Store encrypted vault keys in chrome.storage.session
 */
export async function storeVaultKeys(vaultKeys: VaultKeyData[]): Promise<void> {
	console.log("[storage-chrome] Storing vault keys:", vaultKeys.length, "keys");
	try {
		await chrome.storage.session.set({
			[VAULT_KEYS_KEY]: JSON.stringify(vaultKeys),
		});
		console.log("[storage-chrome] Vault keys stored successfully");

		// Verify the write
		const verification = await chrome.storage.session.get(VAULT_KEYS_KEY);
		console.log(
			"[storage-chrome] Verification - vault keys exist:",
			!!verification[VAULT_KEYS_KEY],
		);
	} catch (error) {
		console.error("[storage-chrome] Failed to store vault keys:", error);
		throw error;
	}
}

/**
 * Get encrypted vault keys from chrome.storage.session
 */
export async function getVaultKeys(): Promise<VaultKeyData[] | null> {
	console.log("[storage-chrome] Getting vault keys from session storage");
	const result = await chrome.storage.session.get(VAULT_KEYS_KEY);
	const stored = result[VAULT_KEYS_KEY];
	console.log(
		"[storage-chrome] Vault keys found:",
		!!stored,
		stored ? `(${JSON.parse(stored).length} keys)` : "(none)",
	);
	return stored ? JSON.parse(stored) : null;
}

/**
 * Store Master Unlock Key in memory cache
 * Also persisted to chrome.storage.local (encrypted with device key) for session restoration
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
 * Note: This keeps the Secret Key for quick unlock next time
 * Use clearAllStoredData() to remove Secret Key as well
 */
export async function clearSession(): Promise<void> {
	await chrome.storage.session.remove([JWT_TOKEN_KEY, VAULT_KEYS_KEY]);
	masterUnlockKeyCache = null;
	await clearStoredSession();
}

/**
 * Check if user is authenticated
 */
export async function isAuthenticated(): Promise<boolean> {
	const token = await getAuthToken();
	return token !== null;
}

/**
 * Try to restore Master Unlock Key from stored session
 * Returns true if successfully restored, false if session expired or unavailable
 */
export async function tryRestoreSession(): Promise<boolean> {
	if (!(await isSessionValid())) {
		return false;
	}

	const masterUnlockKey = await decryptStoredMasterUnlockKey();
	if (!masterUnlockKey) {
		return false;
	}

	storeMasterUnlockKey(masterUnlockKey);
	return true;
}
