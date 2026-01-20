/// <reference lib="dom" />
/**
 * Session Storage Utilities
 * Manages persistent session data with encryption and expiry
 * 1Password-style: Secret Key on device, password-only quick unlock
 */

import { decrypt, type EncryptedData, encrypt } from "./encryption";
import { arrayBufferToBase64, base64ToArrayBuffer } from "./key-derivation";
import { rsaDecrypt } from "./rsa";

// Storage keys
const SECRET_KEY_STORAGE = "bittery_secret_key";
const SESSION_DATA_STORAGE = "bittery_session_data";
const DEVICE_KEY_STORAGE = "bittery_device_key";
const JWT_TOKEN_KEY = "bittery_jwt_token";
const VAULT_KEYS_KEY = "bittery_vault_keys";
const SERVER_URL_STORAGE = "bittery_server_url";
const ENCRYPTED_PRIVATE_KEY_STORAGE = "bittery_encrypted_private_key";

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
	if (typeof window === "undefined") return new Uint8Array(32);

	const stored = localStorage.getItem(DEVICE_KEY_STORAGE);
	if (stored) {
		return base64ToArrayBuffer(stored);
	}

	// Generate new device key
	const deviceKey = crypto.getRandomValues(new Uint8Array(32));
	localStorage.setItem(DEVICE_KEY_STORAGE, arrayBufferToBase64(deviceKey));
	return deviceKey;
}

/**
 * Store Secret Key in localStorage (plaintext - safe because useless without password)
 */
export function storeSecretKey(secretKey: string): void {
	if (typeof window !== "undefined") {
		localStorage.setItem(SECRET_KEY_STORAGE, secretKey);
	}
}

/**
 * Get stored Secret Key
 */
export function getStoredSecretKey(): string | null {
	if (typeof window !== "undefined") {
		return localStorage.getItem(SECRET_KEY_STORAGE);
	}
	return null;
}

/**
 * Check if Secret Key is stored (user has logged in on this device before)
 */
export function hasStoredSecretKey(): boolean {
	return getStoredSecretKey() !== null;
}

/**
 * Store API server URL in localStorage
 */
export function storeServerUrl(serverUrl: string): void {
	if (typeof window !== "undefined") {
		localStorage.setItem(SERVER_URL_STORAGE, serverUrl);
	}
}

/**
 * Get stored API server URL
 */
export function getServerUrl(): string | null {
	if (typeof window !== "undefined") {
		return localStorage.getItem(SERVER_URL_STORAGE);
	}
	return null;
}

/**
 * Clear stored API server URL
 */
export function clearServerUrl(): void {
	if (typeof window !== "undefined") {
		localStorage.removeItem(SERVER_URL_STORAGE);
	}
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
	if (typeof window === "undefined") return;

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

	localStorage.setItem(SESSION_DATA_STORAGE, JSON.stringify(sessionData));
}

/**
 * Get stored session data and check if it's still valid
 */
export function getStoredSessionData(): StoredSessionData | null {
	if (typeof window === "undefined") return null;

	const stored = localStorage.getItem(SESSION_DATA_STORAGE);
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
export function isSessionValid(): boolean {
	const sessionData = getStoredSessionData();
	if (!sessionData) return false;

	const now = Date.now();
	return now < sessionData.expiresAt;
}

/**
 * Get time until session expires (in milliseconds)
 */
export function getTimeUntilExpiry(): number | null {
	const sessionData = getStoredSessionData();
	if (!sessionData) return null;

	const now = Date.now();
	const timeLeft = sessionData.expiresAt - now;
	return timeLeft > 0 ? timeLeft : 0;
}

/**
 * Decrypt Master Unlock Key from stored session
 */
export async function decryptStoredMasterUnlockKey(): Promise<Uint8Array | null> {
	const sessionData = getStoredSessionData();
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
export function clearStoredSession(): void {
	if (typeof window === "undefined") return;
	localStorage.removeItem(SESSION_DATA_STORAGE);
}

/**
 * Clear everything including Secret Key (complete logout from device)
 */
export function clearAllStoredData(): void {
	if (typeof window === "undefined") return;
	localStorage.removeItem(SECRET_KEY_STORAGE);
	localStorage.removeItem(SESSION_DATA_STORAGE);
	localStorage.removeItem(DEVICE_KEY_STORAGE);
}

/**
 * Check if quick unlock is available
 * Requires: stored secret key + valid session
 */
export function canQuickUnlock(): boolean {
	return hasStoredSecretKey() && isSessionValid();
}

/**
 * Store JWT token in sessionStorage
 */
export function storeAuthToken(token: string): void {
	if (typeof window !== "undefined") {
		sessionStorage.setItem(JWT_TOKEN_KEY, token);
	}
}

/**
 * Get JWT token from sessionStorage
 */
export function getAuthToken(): string | null {
	if (typeof window !== "undefined") {
		return sessionStorage.getItem(JWT_TOKEN_KEY);
	}
	return null;
}

/**
 * Store encrypted vault keys in sessionStorage
 */
export function storeVaultKeys(vaultKeys: VaultKeyData[]): void {
	if (typeof window !== "undefined") {
		sessionStorage.setItem(VAULT_KEYS_KEY, JSON.stringify(vaultKeys));
	}
}

/**
 * Get encrypted vault keys from sessionStorage
 */
export function getVaultKeys(): VaultKeyData[] | null {
	if (typeof window !== "undefined") {
		const stored = sessionStorage.getItem(VAULT_KEYS_KEY);
		return stored ? JSON.parse(stored) : null;
	}
	return null;
}

/**
 * Store encrypted private key in sessionStorage
 * This is needed to decrypt vault keys that were shared via RSA encryption
 */
export function storeEncryptedPrivateKey(encryptedPrivateKey: string): void {
	if (typeof window !== "undefined") {
		sessionStorage.setItem(ENCRYPTED_PRIVATE_KEY_STORAGE, encryptedPrivateKey);
	}
}

/**
 * Get encrypted private key from sessionStorage
 */
export function getEncryptedPrivateKey(): string | null {
	if (typeof window !== "undefined") {
		return sessionStorage.getItem(ENCRYPTED_PRIVATE_KEY_STORAGE);
	}
	return null;
}

/**
 * Store Master Unlock Key in memory cache
 * Also persisted to localStorage (encrypted with device key) for session restoration
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
	if (isSessionValid()) {
		const restored = await decryptStoredMasterUnlockKey();
		if (restored) {
			masterUnlockKeyCache = restored;
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
): Promise<Uint8Array> {
	const masterUnlockKey = await getMasterUnlockKey();
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
	const encryptedPrivateKey = getEncryptedPrivateKey();
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
): Promise<Uint8Array | null> {
	const vaultKeys = getVaultKeys();
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
export function clearSession(): void {
	if (typeof window !== "undefined") {
		sessionStorage.removeItem(JWT_TOKEN_KEY);
		sessionStorage.removeItem(VAULT_KEYS_KEY);
		sessionStorage.removeItem(ENCRYPTED_PRIVATE_KEY_STORAGE);
	}
	masterUnlockKeyCache = null;
	clearStoredSession();
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
	return getAuthToken() !== null;
}

/**
 * Try to restore Master Unlock Key from stored session
 * Returns true if successfully restored, false if session expired or unavailable
 */
export async function tryRestoreSession(): Promise<boolean> {
	if (!isSessionValid()) {
		return false;
	}

	const masterUnlockKey = await decryptStoredMasterUnlockKey();
	if (!masterUnlockKey) {
		return false;
	}

	storeMasterUnlockKey(masterUnlockKey);
	return true;
}
