/**
 * Web Storage Adapter
 * Uses localStorage for persistent data and sessionStorage for session data
 */
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
	type ActiveAccount,
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
 * Web Storage Adapter Implementation
 */
export class WebStorageAdapter implements IStorageAdapter {
	readonly platform = "web" as const;
	readonly supportsMultiAccount = false;
	readonly supportsBiometric = false;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		// No initialization needed for web localStorage/sessionStorage
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
		sessionId?: string,
	): Promise<void> {
		if (typeof window === "undefined") return;

		const deviceKey = await getDeviceKey();
		const now = Date.now();

		// Encrypt Master Unlock Key with device key
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const encryptedMUK = await this.crypto.encrypt(mukBase64, deviceKey);

		const sessionData: StoredSessionData = {
			encryptedMasterUnlockKey: encryptedMUK,
			email,
			userId,
			sessionId,
			expiresAt: now + expiryMs,
			createdAt: now,
		};

		localStorage.setItem(SESSION_DATA_STORAGE, JSON.stringify(sessionData));
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
		if (typeof window !== "undefined") {
			localStorage.setItem(SECRET_KEY_STORAGE, secretKey);
		}
	}

	async getStoredSecretKey(_email?: string): Promise<string | null> {
		if (typeof window !== "undefined") {
			return localStorage.getItem(SECRET_KEY_STORAGE);
		}
		return null;
	}

	async storeAuthToken(token: string, _email?: string): Promise<void> {
		if (typeof window !== "undefined") {
			sessionStorage.setItem(JWT_TOKEN_KEY, token);
		}
	}

	async getAuthToken(_email?: string): Promise<string | null> {
		if (typeof window !== "undefined") {
			return sessionStorage.getItem(JWT_TOKEN_KEY);
		}
		return null;
	}

	async storeVaultKeys(
		vaultKeys: VaultKeyData[],
		_email?: string,
	): Promise<void> {
		if (typeof window !== "undefined") {
			sessionStorage.setItem(VAULT_KEYS_KEY, JSON.stringify(vaultKeys));
		}
	}

	async getVaultKeys(_email?: string): Promise<VaultKeyData[] | null> {
		if (typeof window !== "undefined") {
			const stored = sessionStorage.getItem(VAULT_KEYS_KEY);
			return stored ? JSON.parse(stored) : null;
		}
		return null;
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
		if (typeof window !== "undefined") {
			sessionStorage.setItem(
				ENCRYPTED_PRIVATE_KEY_STORAGE,
				encryptedPrivateKey,
			);
		}
	}

	async getEncryptedPrivateKey(_email?: string): Promise<string | null> {
		if (typeof window !== "undefined") {
			return sessionStorage.getItem(ENCRYPTED_PRIVATE_KEY_STORAGE);
		}
		return null;
	}

	// ============================================================================
	// Multi-Account (not supported on web)
	// ============================================================================

	async getActiveAccount(): Promise<ActiveAccount> {
		const sessionData = await this.getStoredSessionData();
		if (!sessionData?.email) return null;
		return { type: "single", email: sessionData.email };
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const sessionData = await this.getStoredSessionData();
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(_account: ActiveAccount): Promise<void> {
		// Web doesn't support multi-account
	}

	async getAccountsList(): Promise<AccountMetadata[]> {
		// Web only supports single account
		const sessionData = await this.getStoredSessionData();
		if (!sessionData) return [];

		return [
			{
				email: sessionData.email,
				userId: sessionData.userId,
				name: "", // Not stored on web
				secretKeyHint: "",
				addedAt: sessionData.createdAt,
				lastActiveAt: Date.now(),
				biometricEnabled: false,
			},
		];
	}

	async addAccount(_metadata: AccountMetadata): Promise<void> {
		// Web doesn't support multi-account
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
		if (typeof window !== "undefined") {
			localStorage.setItem(AUTO_LOCK_TIMEOUT_STORAGE, String(timeoutMs));
		}
	}

	async getAutoLockTimeout(_email?: string): Promise<number | null> {
		if (typeof window !== "undefined") {
			const stored = localStorage.getItem(AUTO_LOCK_TIMEOUT_STORAGE);
			if (stored !== null) {
				const parsed = Number.parseInt(stored, 10);
				if (!Number.isNaN(parsed)) {
					return parsed;
				}
			}
		}
		return null;
	}

	async getAutoLockTimeoutOrDefault(_email?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout();
		// Default: 10 minutes
		return timeout ?? 10 * 60 * 1000;
	}

	async storeServerUrl(serverUrl: string, _email?: string): Promise<void> {
		if (typeof window !== "undefined") {
			localStorage.setItem(SERVER_URL_STORAGE, serverUrl);
		}
	}

	async getServerUrl(_email?: string): Promise<string | null> {
		if (typeof window !== "undefined") {
			return localStorage.getItem(SERVER_URL_STORAGE);
		}
		return null;
	}

	// ============================================================================
	// Auth State
	// ============================================================================

	async isAuthenticated(_email?: string): Promise<boolean> {
		return (await this.getAuthToken()) !== null;
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
		if (typeof window !== "undefined") {
			sessionStorage.removeItem(JWT_TOKEN_KEY);
			sessionStorage.removeItem(VAULT_KEYS_KEY);
			sessionStorage.removeItem(ENCRYPTED_PRIVATE_KEY_STORAGE);
		}
		masterUnlockKeyCache = null;
		this.clearStoredSession();
	}

	async clearAllStoredData(_email?: string): Promise<void> {
		if (typeof window === "undefined") return;
		localStorage.removeItem(SECRET_KEY_STORAGE);
		localStorage.removeItem(SESSION_DATA_STORAGE);
		localStorage.removeItem(DEVICE_KEY_STORAGE);
		await this.clearSession();
	}

	async getStoredSessionData(
		_email?: string,
	): Promise<StoredSessionData | null> {
		if (typeof window === "undefined") return null;

		const stored = localStorage.getItem(SESSION_DATA_STORAGE);
		if (!stored) return null;

		try {
			return JSON.parse(stored) as StoredSessionData;
		} catch {
			return null;
		}
	}

	// ============================================================================
	// Extended Session Management (unified interface)
	// ============================================================================

	async hasStoredSecretKey(_email?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey();
		return secretKey != null;
	}

	async lockAllAccounts(): Promise<void> {
		// Web only has single account, just clear the cache
		masterUnlockKeyCache = null;
	}

	async getAccountMetadata(_email: string): Promise<AccountMetadata | null> {
		// Web doesn't support multi-account metadata, return basic info from session
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

	/**
	 * Get list of unlocked account emails
	 * Web only supports single account, so returns array with current account if unlocked
	 */
	async getUnlockedAccounts(): Promise<string[]> {
		if (!masterUnlockKeyCache) return [];

		const sessionData = await this.getStoredSessionData();
		return sessionData ? [sessionData.email] : [];
	}

	// ============================================================================
	// Extended Biometric (stubs for web - not supported)
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
			message: "Biometric authentication is not available on web",
		};
	}

	// ============================================================================
	// Mobile-Specific (stubs for web - not applicable)
	// ============================================================================

	async isMasterPasswordReentryRequired(_email?: string): Promise<boolean> {
		// Web doesn't enforce 30-day re-entry
		return false;
	}

	async updateLastMasterPasswordEntry(_email?: string): Promise<void> {
		// No-op for web
	}

	async decryptStoredMasterUnlockKey(
		_email?: string,
		_skipBiometric?: boolean,
	): Promise<Uint8Array | null> {
		return this.decryptStoredMasterUnlockKeyInternal();
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
			return base64ToArrayBuffer(mukBase64);
		} catch {
			return null;
		}
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private clearStoredSession(): void {
		if (typeof window === "undefined") return;
		localStorage.removeItem(SESSION_DATA_STORAGE);
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
				base64ToArrayBuffer(mukBase64),
			);
			return base64ToArrayBuffer(decryptedBase64);
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
			base64ToArrayBuffer(mukBase64),
		);

		// Use RSA to decrypt vault key
		const vaultKeyBase64 = await this.crypto.rsaDecrypt(
			encryptedVaultKey,
			privateKeyPEM,
		);
		return base64ToArrayBuffer(vaultKeyBase64);
	}
}

/**
 * Create a new Web Storage Adapter instance
 * @param crypto - CryptoProvider implementation for encryption operations
 */
export function createWebStorageAdapter(
	crypto: CryptoProvider,
): IStorageAdapter {
	return new WebStorageAdapter(crypto);
}
