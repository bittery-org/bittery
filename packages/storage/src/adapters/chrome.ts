/**
 * Chrome Extension Storage Adapter
 * Uses chrome.storage APIs instead of localStorage/sessionStorage
 */
/// <reference types="chrome" />
/// <reference lib="dom" />

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import type { EncryptedData } from "@bittery/types";
import type { IStorageAdapter } from "../adapter";
import type { CryptoProvider } from "../crypto-provider";
import {
	type AccountMetadata,
	type BiometricAuthResult,
	DEFAULT_SESSION_EXPIRY_MS,
	type StoredSessionData,
	type VaultKeyData,
} from "../types";

// Storage keys
const SECRET_KEY_STORAGE = "bittery_secret_key";
const SESSION_DATA_STORAGE = "bittery_session_data";
const DEVICE_KEY_STORAGE = "bittery_device_key";
const JWT_TOKEN_KEY = "bittery_jwt_token";
const VAULT_KEYS_KEY = "bittery_vault_keys";
const SERVER_URL_STORAGE = "bittery_server_url";
const ENCRYPTED_PRIVATE_KEY_STORAGE = "bittery_encrypted_private_key";
const AUTO_LOCK_TIMEOUT_STORAGE = "bittery_auto_lock_timeout";

// In-memory cache for Master Unlock Key
let masterUnlockKeyCache: Uint8Array | null = null;

/**
 * Generate or retrieve device-specific encryption key
 */
async function getDeviceKey(): Promise<Uint8Array> {
	const result = await chrome.storage.local.get(DEVICE_KEY_STORAGE);
	const stored = result[DEVICE_KEY_STORAGE];

	if (stored) {
		return base64ToArrayBuffer(stored as string) as Uint8Array;
	}

	// Generate new device key
	const deviceKey = crypto.getRandomValues(new Uint8Array(32)) as Uint8Array;
	await chrome.storage.local.set({
		[DEVICE_KEY_STORAGE]: arrayBufferToBase64(deviceKey),
	});
	return deviceKey;
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
		return false;
	}
}

/**
 * Chrome Extension Storage Adapter Implementation
 */
export class ChromeStorageAdapter implements IStorageAdapter {
	readonly platform = "extension" as const;
	readonly supportsMultiAccount = false;
	readonly supportsBiometric = false;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		// No initialization needed for chrome.storage
	}

	// ============================================================================
	// Session Management
	// ============================================================================

	async getMasterUnlockKey(_email?: string): Promise<Uint8Array | null> {
		// Return from memory cache if available
		if (masterUnlockKeyCache) {
			return masterUnlockKeyCache;
		}

		// Try to restore from persistent storage if session is still valid
		if (await this.isSessionValid()) {
			const restored = await this.decryptStoredMasterUnlockKeyInternal();
			if (restored) {
				masterUnlockKeyCache = restored;
				return restored;
			}
		}

		return null;
	}

	async setMasterUnlockKey(key: Uint8Array, _email?: string): Promise<void> {
		masterUnlockKeyCache = key;
	}

	async clearMasterUnlockKey(_email?: string): Promise<void> {
		masterUnlockKeyCache = null;
	}

	async storeSessionData(
		masterUnlockKey: Uint8Array,
		email: string,
		userId: string,
		expiryMs: number = DEFAULT_SESSION_EXPIRY_MS,
	): Promise<void> {
		const deviceKey = await getDeviceKey();
		const now = Date.now();

		// Encrypt Master Unlock Key with device key
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const encryptedMUK = await this.crypto.encrypt(mukBase64, deviceKey);

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

	async tryRestoreSession(
		_skipBiometric?: boolean,
		_email?: string,
	): Promise<boolean> {
		if (!(await this.isSessionValid())) {
			return false;
		}

		// First check if MUK is already in memory cache (e.g., after login)
		if (masterUnlockKeyCache) {
			return true;
		}

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal();
		if (!masterUnlockKey) {
			return false;
		}

		masterUnlockKeyCache = masterUnlockKey;
		return true;
	}

	async isSessionValid(_email?: string): Promise<boolean> {
		const sessionData = await this.getStoredSessionData();
		if (!sessionData) return false;

		const now = Date.now();
		return now < sessionData.expiresAt;
	}

	// ============================================================================
	// Credentials
	// ============================================================================

	async storeSecretKey(secretKey: string, _email?: string): Promise<void> {
		await chrome.storage.local.set({ [SECRET_KEY_STORAGE]: secretKey });
	}

	async getStoredSecretKey(_email?: string): Promise<string | null> {
		const result = await chrome.storage.local.get(SECRET_KEY_STORAGE);
		return (result[SECRET_KEY_STORAGE] as string | undefined) || null;
	}

	async storeAuthToken(token: string, _email?: string): Promise<void> {
		await chrome.storage.session.set({ [JWT_TOKEN_KEY]: token });
	}

	async getAuthToken(_email?: string): Promise<string | null> {
		const result = await chrome.storage.session.get(JWT_TOKEN_KEY);
		return (result[JWT_TOKEN_KEY] as string | undefined) || null;
	}

	async storeVaultKeys(
		vaultKeys: VaultKeyData[],
		_email?: string,
	): Promise<void> {
		console.log(
			"[storage-chrome] Storing vault keys:",
			vaultKeys.length,
			"keys",
		);
		try {
			await chrome.storage.session.set({
				[VAULT_KEYS_KEY]: JSON.stringify(vaultKeys),
			});
			console.log("[storage-chrome] Vault keys stored successfully");
		} catch (error) {
			console.error("[storage-chrome] Failed to store vault keys:", error);
			throw error;
		}
	}

	async getVaultKeys(_email?: string): Promise<VaultKeyData[] | null> {
		console.log("[storage-chrome] Getting vault keys from session storage");
		const result = await chrome.storage.session.get(VAULT_KEYS_KEY);
		const stored = result[VAULT_KEYS_KEY];
		console.log(
			"[storage-chrome] Vault keys found:",
			!!stored,
			stored ? `(${JSON.parse(stored as string).length} keys)` : "(none)",
		);
		return stored ? JSON.parse(stored as string) : null;
	}

	async getDecryptedVaultKey(
		vaultId: string,
		_email?: string,
	): Promise<Uint8Array | null> {
		const vaultKeys = await this.getVaultKeys();
		if (!vaultKeys) return null;

		const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
		if (!vaultKeyData) return null;

		return this.decryptVaultKey(vaultKeyData.encryptedVaultKey);
	}

	async storeEncryptedPrivateKey(
		encryptedPrivateKey: string,
		_email?: string,
	): Promise<void> {
		await chrome.storage.session.set({
			[ENCRYPTED_PRIVATE_KEY_STORAGE]: encryptedPrivateKey,
		});
	}

	async getEncryptedPrivateKey(_email?: string): Promise<string | null> {
		const result = await chrome.storage.session.get(
			ENCRYPTED_PRIVATE_KEY_STORAGE,
		);
		return (
			(result[ENCRYPTED_PRIVATE_KEY_STORAGE] as string | undefined) || null
		);
	}

	// ============================================================================
	// Multi-Account (not supported on extension)
	// ============================================================================

	async getActiveAccountEmail(): Promise<string | null> {
		const sessionData = await this.getStoredSessionData();
		return sessionData?.email ?? null;
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const sessionData = await this.getStoredSessionData();
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(_email: string): Promise<void> {
		// Extension doesn't support multi-account
	}

	async getAccountsList(): Promise<AccountMetadata[]> {
		const sessionData = await this.getStoredSessionData();
		if (!sessionData) return [];

		return [
			{
				email: sessionData.email,
				userId: sessionData.userId,
				name: "",
				secretKeyHint: "",
				addedAt: sessionData.createdAt,
				lastActiveAt: Date.now(),
				biometricEnabled: false,
			},
		];
	}

	async addAccount(_metadata: AccountMetadata): Promise<void> {
		// Extension doesn't support multi-account
	}

	async removeAccount(_email: string): Promise<void> {
		await this.clearAllStoredData();
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(
		timeoutMs: number,
		_email?: string,
	): Promise<void> {
		await chrome.storage.local.set({ [AUTO_LOCK_TIMEOUT_STORAGE]: timeoutMs });
	}

	async getAutoLockTimeout(_email?: string): Promise<number | null> {
		const result = await chrome.storage.local.get(AUTO_LOCK_TIMEOUT_STORAGE);
		const stored = result[AUTO_LOCK_TIMEOUT_STORAGE];
		if (stored !== undefined && typeof stored === "number") {
			return stored;
		}
		return null;
	}

	async getAutoLockTimeoutOrDefault(_email?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout();
		// Default: 10 minutes
		return timeout ?? 10 * 60 * 1000;
	}

	async storeServerUrl(serverUrl: string, _email?: string): Promise<void> {
		await chrome.storage.local.set({ [SERVER_URL_STORAGE]: serverUrl });
	}

	async getServerUrl(_email?: string): Promise<string | null> {
		const result = await chrome.storage.local.get(SERVER_URL_STORAGE);
		return (result[SERVER_URL_STORAGE] as string | undefined) || null;
	}

	// ============================================================================
	// Auth State
	// ============================================================================

	async isAuthenticated(_email?: string): Promise<boolean> {
		const token = await this.getAuthToken();
		return token !== null;
	}

	async canQuickUnlock(_email?: string): Promise<boolean> {
		const hasSecretKey = (await this.getStoredSecretKey()) !== null;
		const sessionValid = await this.isSessionValid();
		return hasSecretKey && sessionValid;
	}

	// ============================================================================
	// Clear
	// ============================================================================

	async clearSession(_email?: string): Promise<void> {
		await chrome.storage.session.remove([
			JWT_TOKEN_KEY,
			VAULT_KEYS_KEY,
			ENCRYPTED_PRIVATE_KEY_STORAGE,
		]);
		masterUnlockKeyCache = null;
		await this.clearStoredSession();
	}

	async clearAllStoredData(_email?: string): Promise<void> {
		await chrome.storage.local.remove([
			SECRET_KEY_STORAGE,
			SESSION_DATA_STORAGE,
			DEVICE_KEY_STORAGE,
		]);
		await chrome.storage.session.clear();
		masterUnlockKeyCache = null;
	}

	// ============================================================================
	// Extended Session Management (unified interface)
	// ============================================================================

	async getStoredSessionData(
		_email?: string,
	): Promise<StoredSessionData | null> {
		const result = await chrome.storage.local.get(SESSION_DATA_STORAGE);
		const stored = result[SESSION_DATA_STORAGE];

		if (!stored) return null;

		try {
			return JSON.parse(stored as string) as StoredSessionData;
		} catch {
			return null;
		}
	}

	async hasStoredSecretKey(_email?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey();
		return secretKey != null;
	}

	async lockAllAccounts(): Promise<void> {
		masterUnlockKeyCache = null;
	}

	async getAccountMetadata(_email: string): Promise<AccountMetadata | null> {
		const sessionData = await this.getStoredSessionData();
		if (!sessionData) return null;

		return {
			email: sessionData.email,
			userId: sessionData.userId,
			name: "",
			secretKeyHint: "",
			addedAt: sessionData.createdAt,
			lastActiveAt: Date.now(),
			biometricEnabled: false,
		};
	}

	// ============================================================================
	// Extended Biometric (stubs - not supported on Chrome extension)
	// ============================================================================

	async getBiometricAvailabilityDetails(): Promise<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}> {
		return { hasHardware: false, isEnrolled: false };
	}

	async getBiometricType(): Promise<string | null> {
		return null;
	}

	async unlockWithBiometric(_email?: string): Promise<boolean> {
		return false;
	}

	async authenticateWithBiometricEnhanced(
		_reason?: string,
		_email?: string,
	): Promise<BiometricAuthResult> {
		return {
			success: false,
			error: "not_available",
			message:
				"Biometric authentication is not available in browser extensions",
		};
	}

	// ============================================================================
	// Mobile-Specific (stubs - not applicable for Chrome extension)
	// ============================================================================

	async isMasterPasswordReentryRequired(_email?: string): Promise<boolean> {
		return false;
	}

	async updateLastMasterPasswordEntry(_email?: string): Promise<void> {
		// No-op
	}

	async decryptStoredMasterUnlockKey(
		_email?: string,
		_skipBiometric?: boolean,
	): Promise<Uint8Array | null> {
		return this.decryptStoredMasterUnlockKeyInternal();
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async clearStoredSession(): Promise<void> {
		await chrome.storage.local.remove(SESSION_DATA_STORAGE);
	}

	private async decryptStoredMasterUnlockKeyInternal(): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData();
		if (!sessionData) return null;

		try {
			const deviceKey = await getDeviceKey();
			const mukBase64 = await this.crypto.decrypt(
				sessionData.encryptedMasterUnlockKey,
				deviceKey,
			);
			return base64ToArrayBuffer(mukBase64) as Uint8Array;
		} catch {
			return null;
		}
	}

	async decryptVaultKey(
		encryptedVaultKey: string,
		_email?: string,
	): Promise<Uint8Array> {
		const muk = await this.getMasterUnlockKey();
		if (!muk) {
			throw new Error("Master Unlock Key not available. Please log in again.");
		}

		if (isAesEncryptedVaultKey(encryptedVaultKey)) {
			// AES-GCM encrypted (owner's vault key)
			const encryptedData: EncryptedData = JSON.parse(encryptedVaultKey);
			const mukBase64 = arrayBufferToBase64(muk);
			const decryptedBase64 = await this.crypto.decrypt(
				encryptedData,
				base64ToArrayBuffer(mukBase64) as Uint8Array,
			);
			return base64ToArrayBuffer(decryptedBase64) as Uint8Array;
		}

		// RSA encrypted (shared vault key)
		const encryptedPrivateKey = await this.getEncryptedPrivateKey();
		if (!encryptedPrivateKey) {
			throw new Error(
				"Encrypted private key not available. Please log in again.",
			);
		}

		// Decrypt private key with MUK
		const privateKeyEncryptedData: EncryptedData =
			JSON.parse(encryptedPrivateKey);
		const mukBase64 = arrayBufferToBase64(muk);
		const privateKeyPEM = await this.crypto.decrypt(
			privateKeyEncryptedData,
			base64ToArrayBuffer(mukBase64) as Uint8Array,
		);

		// Use RSA to decrypt vault key
		const vaultKeyBase64 = await this.crypto.rsaDecrypt(
			encryptedVaultKey,
			privateKeyPEM,
		);
		return base64ToArrayBuffer(vaultKeyBase64) as Uint8Array;
	}
}

/**
 * Create a new Chrome Storage Adapter instance
 * @param crypto - CryptoProvider implementation for encryption operations
 */
export function createChromeStorageAdapter(
	crypto: CryptoProvider,
): IStorageAdapter {
	return new ChromeStorageAdapter(crypto);
}
