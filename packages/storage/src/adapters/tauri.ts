/**
 * Tauri Desktop Storage Adapter with Biometric Authentication
 * Uses Tauri's Store plugin + OS Keychain for sensitive data
 *
 * Security: The device key (which encrypts the Master Unlock Key at rest)
 * is stored in the OS keychain (macOS Keychain, Windows Credential Manager,
 * Linux Secret Service) for enhanced protection.
 */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import type { EncryptedData } from "@bittery/types";
import type { Store } from "@tauri-apps/plugin-store";
import type { IStorageAdapter } from "../adapter";
import type { CryptoProvider } from "../crypto-provider";
import {
	type AccountMetadata,
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	type StoredSessionData,
	type VaultKeyData,
} from "../types";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_KEYCHAIN_KEY = "device_key"; // Stored in OS keychain
const DEVICE_KEY_STORAGE_LEGACY = "bittery_device_key"; // Legacy: Tauri Store (for migration)
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";
const LEGACY_SERVER_URL_STORAGE = "bittery_server_url"; // Legacy, now account-scoped

// Helper to generate namespaced keys for each account
function getAccountKey(email: string, suffix: string): string {
	const sanitized = email.toLowerCase().replace(/[^a-z0-9]/g, "_");
	return `bittery_account_${sanitized}_${suffix}`;
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

// Cache for active account email to avoid repeated IPC calls
let cachedActiveAccountEmail: string | null = null;

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
 * Tauri command invoke types for keychain operations
 */
interface TauriInvoke {
	(cmd: "keychain_set", args: { key: string; value: string }): Promise<void>;
	(cmd: "keychain_get", args: { key: string }): Promise<string | null>;
	(cmd: "keychain_delete", args: { key: string }): Promise<boolean>;
}

/**
 * Tauri Storage Adapter Implementation
 */
export class TauriStorageAdapter implements IStorageAdapter {
	readonly platform = "desktop" as const;
	readonly supportsMultiAccount = true;
	readonly supportsBiometric = true;

	private store: Store | null = null;
	private biometryModule:
		| typeof import("@choochmeque/tauri-plugin-biometry-api")
		| null = null;
	private storeModule: typeof import("@tauri-apps/plugin-store") | null = null;
	private invoke: TauriInvoke | null = null;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		// Dynamically import Tauri plugins to avoid bundling issues in non-Tauri environments
		try {
			this.storeModule = await import("@tauri-apps/plugin-store");
			this.store = await this.storeModule.Store.load("store.json");
		} catch (error) {
			console.error("[storage-tauri] Failed to initialize store:", error);
			throw error;
		}

		try {
			const tauriCore = await import("@tauri-apps/api/core");
			this.invoke = tauriCore.invoke as TauriInvoke;
		} catch (error) {
			console.error("[storage-tauri] Failed to initialize Tauri core:", error);
			throw error;
		}

		try {
			this.biometryModule = await import(
				"@choochmeque/tauri-plugin-biometry-api"
			);
		} catch (error) {
			console.warn("[storage-tauri] Biometry module not available:", error);
		}

		// Pre-load active account email into cache to avoid repeated IPC calls
		if (this.store) {
			const email = await this.store.get<string>(ACTIVE_ACCOUNT_KEY);
			cachedActiveAccountEmail = email ?? null;
		}
	}

	private async getStore(): Promise<Store> {
		if (!this.store) {
			throw new Error(
				"TauriStorageAdapter not initialized. Call initialize() first.",
			);
		}
		return this.store;
	}

	private async resolveEmail(email?: string): Promise<string | null> {
		if (email) return email.toLowerCase();
		return this.getActiveAccountEmail();
	}

	private getAccountCache(email: string): AccountCache {
		const key = email.toLowerCase();
		let cache = accountCaches.get(key);
		if (!cache) {
			cache = { authToken: null, vaultKeys: null, masterUnlockKey: null };
			accountCaches.set(key, cache);
		}
		return cache;
	}

	private clearAccountCache(email: string): void {
		accountCaches.delete(email.toLowerCase());
	}

	private async getDeviceKey(): Promise<Uint8Array> {
		if (!this.invoke) {
			throw new Error(
				"TauriStorageAdapter not initialized. Call initialize() first.",
			);
		}

		const store = await this.getStore();

		// Try to get device key from OS keychain first
		try {
			const keychainValue = await this.invoke("keychain_get", {
				key: DEVICE_KEY_KEYCHAIN_KEY,
			});
			if (keychainValue) {
				console.log("[storage-tauri] Device key retrieved from OS keychain");
				return base64ToArrayBuffer(keychainValue);
			}
		} catch (error) {
			console.warn(
				"[storage-tauri] Failed to read device key from keychain:",
				error,
			);
		}

		// Fallback: Check if device key exists in Tauri Store (backup/legacy)
		const storedKey = await store.get<string>(DEVICE_KEY_STORAGE_LEGACY);

		if (storedKey) {
			console.log(
				"[storage-tauri] Device key retrieved from Tauri Store backup",
			);
			// Try to sync back to keychain for next time
			try {
				await this.invoke("keychain_set", {
					key: DEVICE_KEY_KEYCHAIN_KEY,
					value: storedKey,
				});
				console.log("[storage-tauri] Device key synced to OS keychain");
			} catch (error) {
				console.warn(
					"[storage-tauri] Failed to sync device key to keychain:",
					error,
				);
			}
			return base64ToArrayBuffer(storedKey);
		}

		// No existing device key found - generate new one
		// This should only happen on first login on this device
		console.log("[storage-tauri] Generating new device key");
		const deviceKey = crypto.getRandomValues(new Uint8Array(32));
		const deviceKeyBase64 = arrayBufferToBase64(deviceKey);

		// Store in BOTH keychain and Tauri Store for redundancy
		// This ensures we can always retrieve the key even if keychain has issues
		let keychainSuccess = false;
		try {
			await this.invoke("keychain_set", {
				key: DEVICE_KEY_KEYCHAIN_KEY,
				value: deviceKeyBase64,
			});
			keychainSuccess = true;
			console.log("[storage-tauri] New device key stored in OS keychain");
		} catch (error) {
			console.error(
				"[storage-tauri] Failed to store device key in keychain:",
				error,
			);
		}

		// Always store in Tauri Store as backup
		await store.set(DEVICE_KEY_STORAGE_LEGACY, deviceKeyBase64);
		await store.save();
		console.log("[storage-tauri] New device key stored in Tauri Store backup");

		if (!keychainSuccess) {
			console.warn(
				"[storage-tauri] Device key only stored in Tauri Store (keychain failed)",
			);
		}

		return deviceKey;
	}

	// ============================================================================
	// Session Management
	// ============================================================================

	async getMasterUnlockKey(email?: string): Promise<Uint8Array | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.masterUnlockKey) {
			return cache.masterUnlockKey;
		}

		// Try to restore from persistent storage if session is still valid
		if (await this.isSessionValid(resolvedEmail)) {
			const restored = await this.decryptStoredMasterUnlockKey(
				resolvedEmail,
				false,
			);
			if (restored) {
				cache.masterUnlockKey = restored;
				return restored;
			}
		}

		return null;
	}

	async setMasterUnlockKey(key: Uint8Array, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedEmail);
		cache.masterUnlockKey = key;
	}

	async clearMasterUnlockKey(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const cache = this.getAccountCache(resolvedEmail);
		cache.masterUnlockKey = null;
	}

	async storeSessionData(
		masterUnlockKey: Uint8Array,
		email: string,
		userId: string,
		expiryMs: number = DEFAULT_SESSION_EXPIRY_MS,
	): Promise<void> {
		const resolvedEmail = email.toLowerCase();
		const store = await this.getStore();
		const deviceKey = await this.getDeviceKey();
		const now = Date.now();

		// Encrypt Master Unlock Key with device key
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const encryptedMUK = await this.crypto.encrypt(mukBase64, deviceKey);

		const biometricEnabled =
			(await this.isBiometricEnabled?.(resolvedEmail)) ?? false;

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

	async tryRestoreSession(
		skipBiometric = false,
		email?: string,
	): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		if (!(await this.isSessionValid(resolvedEmail))) {
			return false;
		}

		// First check if MUK is already in memory cache (e.g., after login)
		const cache = this.getAccountCache(resolvedEmail);
		if (cache.masterUnlockKey) {
			console.log("[storage-tauri] Session restored from memory cache");
			return true;
		}

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey = await this.decryptStoredMasterUnlockKey(
			resolvedEmail,
			skipBiometric,
		);
		if (!masterUnlockKey) {
			return false;
		}

		await this.setMasterUnlockKey(masterUnlockKey, resolvedEmail);
		return true;
	}

	async isSessionValid(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		const sessionData = await this.getStoredSessionData(resolvedEmail);
		if (!sessionData) return false;

		const now = Date.now();
		return now < sessionData.expiresAt;
	}

	// ============================================================================
	// Credentials
	// ============================================================================

	async storeSecretKey(secretKey: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "secret_key");
		await store.set(key, secretKey);
		await store.save();
	}

	async getStoredSecretKey(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "secret_key");
		return (await store.get<string>(key)) ?? null;
	}

	async storeAuthToken(token: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedEmail);
		cache.authToken = token;

		// Also persist to disk for session restoration
		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "jwt_token");
		await store.set(key, token);
		await store.save();
	}

	async getAuthToken(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.authToken) {
			return cache.authToken;
		}

		// Try to restore from disk
		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "jwt_token");
		const token = await store.get<string>(key);
		if (token) {
			cache.authToken = token;
		}

		return token ?? null;
	}

	async storeVaultKeys(
		vaultKeys: VaultKeyData[],
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		console.log(
			"[storage-tauri] Storing vault keys:",
			vaultKeys.length,
			"keys",
		);

		const cache = this.getAccountCache(resolvedEmail);
		cache.vaultKeys = vaultKeys;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "vault_keys");
		await store.set(key, JSON.stringify(vaultKeys));
		await store.save();
	}

	async getVaultKeys(email?: string): Promise<VaultKeyData[] | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.vaultKeys) {
			return cache.vaultKeys;
		}

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "vault_keys");
		const stored = await store.get<string>(key);
		if (stored) {
			cache.vaultKeys = JSON.parse(stored);
		}
		return cache.vaultKeys;
	}

	async getDecryptedVaultKey(
		vaultId: string,
		email?: string,
	): Promise<Uint8Array | null> {
		const vaultKeys = await this.getVaultKeys(email);
		if (!vaultKeys) return null;

		const vaultKeyData = vaultKeys.find((vk) => vk.vaultId === vaultId);
		if (!vaultKeyData) return null;

		return this.decryptVaultKey(vaultKeyData.encryptedVaultKey, email);
	}

	async storeEncryptedPrivateKey(
		encryptedPrivateKey: string,
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "encrypted_private_key");
		await store.set(key, encryptedPrivateKey);
		await store.save();
	}

	async getEncryptedPrivateKey(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "encrypted_private_key");
		return (await store.get<string>(key)) ?? null;
	}

	// ============================================================================
	// Multi-Account
	// ============================================================================

	async getActiveAccountEmail(): Promise<string | null> {
		// Return cached value if available to avoid repeated IPC calls
		if (cachedActiveAccountEmail !== null) {
			return cachedActiveAccountEmail;
		}

		const store = await this.getStore();
		const email = (await store.get<string>(ACTIVE_ACCOUNT_KEY)) ?? null;
		cachedActiveAccountEmail = email;
		return email;
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const email = await this.getActiveAccountEmail();
		if (!email) return null;

		const sessionData = await this.getStoredSessionData(email);
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(email: string): Promise<void> {
		const normalizedEmail = email.toLowerCase();
		const store = await this.getStore();
		await store.set(ACTIVE_ACCOUNT_KEY, normalizedEmail);
		await store.save();

		// Update the cache
		cachedActiveAccountEmail = normalizedEmail;

		// Update lastActiveAt for this account
		const accountsList = await this.getAccountsListInternal();
		const account = accountsList.accounts.find(
			(a) => a.email.toLowerCase() === email.toLowerCase(),
		);
		if (account) {
			account.lastActiveAt = Date.now();
			await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
			await store.save();
		}
	}

	async getAccountsList(): Promise<AccountMetadata[]> {
		const accountsList = await this.getAccountsListInternal();
		return accountsList.accounts;
	}

	private async getAccountsListInternal(): Promise<AccountsList> {
		const store = await this.getStore();
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

	async addAccount(metadata: AccountMetadata): Promise<void> {
		const store = await this.getStore();
		const accountsList = await this.getAccountsListInternal();

		const existingIndex = accountsList.accounts.findIndex(
			(a) => a.email.toLowerCase() === metadata.email.toLowerCase(),
		);

		if (existingIndex >= 0) {
			accountsList.accounts[existingIndex] = metadata;
		} else {
			accountsList.accounts.push(metadata);
		}

		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		await store.save();
	}

	async removeAccount(email: string): Promise<void> {
		const resolvedEmail = email.toLowerCase();
		const store = await this.getStore();

		// Clear the active account cache if removing the active account
		if (cachedActiveAccountEmail === resolvedEmail) {
			cachedActiveAccountEmail = null;
		}

		// Delete all namespaced keys for this account
		await store.delete(getAccountKey(resolvedEmail, "secret_key"));
		await store.delete(getAccountKey(resolvedEmail, "session_data"));
		await store.delete(getAccountKey(resolvedEmail, "jwt_token"));
		await store.delete(getAccountKey(resolvedEmail, "vault_keys"));
		await store.delete(getAccountKey(resolvedEmail, "biometric_enabled"));
		await store.delete(getAccountKey(resolvedEmail, "last_biometric_auth"));
		await store.delete(getAccountKey(resolvedEmail, "server_url"));
		await store.delete(getAccountKey(resolvedEmail, "encrypted_private_key"));
		await store.delete(getAccountKey(resolvedEmail, "auto_lock_timeout"));
		await store.save();

		this.clearAccountCache(resolvedEmail);

		// Remove from accounts list
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.email.toLowerCase() !== resolvedEmail,
		);
		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		await store.save();
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(timeoutMs: number, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
		await store.set(key, timeoutMs);
		await store.save();
	}

	async getAutoLockTimeout(email?: string): Promise<number | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
		return (await store.get<number>(key)) ?? null;
	}

	async getAutoLockTimeoutOrDefault(email?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(email);
		// Default: 10 minutes
		return timeout ?? 10 * 60 * 1000;
	}

	async storeServerUrl(serverUrl: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "server_url");
		await store.set(key, serverUrl);
		await store.save();
	}

	async getServerUrl(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "server_url");
		return (await store.get<string>(key)) ?? null;
	}

	// ============================================================================
	// Auth State
	// ============================================================================

	async isAuthenticated(email?: string): Promise<boolean> {
		const token = await this.getAuthToken(email);
		return token != null;
	}

	async canQuickUnlock(email?: string): Promise<boolean> {
		const hasSecretKey = (await this.getStoredSecretKey(email)) !== null;
		const sessionValid = await this.isSessionValid(email);
		return hasSecretKey && sessionValid;
	}

	// ============================================================================
	// Clear
	// ============================================================================

	async clearSession(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		this.clearAccountCache(resolvedEmail);

		// Clear last biometric auth timestamp so biometric is required on next unlock
		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "last_biometric_auth");
		await store.delete(key);
		await store.save();
	}

	async clearAllStoredData(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (resolvedEmail) {
			await this.removeAccount(resolvedEmail);
		}
	}

	// ============================================================================
	// Biometric
	// ============================================================================

	async isBiometricAvailable(): Promise<boolean> {
		if (!this.biometryModule) return false;
		try {
			const status = await this.biometryModule.checkStatus();
			return status.isAvailable;
		} catch {
			return false;
		}
	}

	async isBiometricEnabled(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "biometric_enabled");
		const enabled = await store.get<boolean>(key);
		return enabled === true;
	}

	async enableBiometric(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "biometric_enabled");
		await store.set(key, true);
		await store.save();
	}

	async disableBiometric(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "biometric_enabled");
		await store.set(key, false);
		await store.save();
	}

	async authenticateWithBiometric(
		reason = "Unlock Bittery",
		email?: string,
	): Promise<boolean> {
		if (!this.biometryModule) return false;

		try {
			const resolvedEmail = await this.resolveEmail(email);
			if (!resolvedEmail) return false;

			await this.biometryModule.authenticate(reason);

			// Update last biometric auth timestamp
			const store = await this.getStore();
			const key = getAccountKey(resolvedEmail, "last_biometric_auth");
			await store.set(key, Date.now());
			await store.save();

			return true;
		} catch (error) {
			console.error("[storage-tauri] Biometric authentication failed:", error);
			return false;
		}
	}

	async canBiometricUnlock(email?: string): Promise<boolean> {
		const available = await this.isBiometricAvailable();
		const enabled = await this.isBiometricEnabled(email);
		const sessionValid = await this.isSessionValid(email);
		return available && enabled && sessionValid;
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async isBiometricAuthRequired(email: string): Promise<boolean> {
		const sessionData = await this.getStoredSessionData(email);
		if (!sessionData || !sessionData.biometricEnabled) {
			return false;
		}

		const store = await this.getStore();
		const key = getAccountKey(email, "last_biometric_auth");
		const lastAuth = await store.get<number>(key);

		if (!lastAuth) {
			return true;
		}

		const timeSinceLastAuth = Date.now() - lastAuth;
		return timeSinceLastAuth > BIOMETRIC_GRACE_PERIOD_MS;
	}

	private async decryptStoredMasterUnlockKey(
		email: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData(email);
		if (!sessionData) {
			console.log("[storage-tauri] No session data found for:", email);
			return null;
		}

		// Check if biometric authentication is required
		if (!skipBiometric && sessionData.biometricEnabled) {
			const authRequired = await this.isBiometricAuthRequired(email);
			if (authRequired) {
				const authenticated = await this.authenticateWithBiometric(
					"Unlock your vault",
					email,
				);
				if (!authenticated) {
					console.log(
						"[storage-tauri] Biometric authentication failed for:",
						email,
					);
					return null;
				}
			}
		}

		try {
			const deviceKey = await this.getDeviceKey();
			const mukBase64 = await this.crypto.decrypt(
				sessionData.encryptedMasterUnlockKey,
				deviceKey,
			);
			console.log(
				"[storage-tauri] Successfully decrypted MUK from session data",
			);
			return base64ToArrayBuffer(mukBase64);
		} catch (error) {
			console.error("[storage-tauri] Failed to decrypt MUK:", error);
			return null;
		}
	}

	async decryptVaultKey(
		encryptedVaultKey: string,
		email?: string,
	): Promise<Uint8Array> {
		const muk = await this.getMasterUnlockKey(email);
		if (!muk) {
			throw new Error("Master Unlock Key not available. Please log in again.");
		}

		if (isAesEncryptedVaultKey(encryptedVaultKey)) {
			const encryptedData: EncryptedData = JSON.parse(encryptedVaultKey);
			const mukBase64 = arrayBufferToBase64(muk);
			const decryptedBase64 = await this.crypto.decrypt(
				encryptedData,
				base64ToArrayBuffer(mukBase64),
			);
			return base64ToArrayBuffer(decryptedBase64);
		}

		// RSA encrypted (shared vault key)
		const encryptedPrivateKey = await this.getEncryptedPrivateKey(email);
		if (!encryptedPrivateKey) {
			throw new Error(
				"Encrypted private key not available. Please log in again.",
			);
		}

		const privateKeyEncryptedData: EncryptedData =
			JSON.parse(encryptedPrivateKey);
		const mukBase64 = arrayBufferToBase64(muk);
		const privateKeyPEM = await this.crypto.decrypt(
			privateKeyEncryptedData,
			base64ToArrayBuffer(mukBase64),
		);

		const vaultKeyBase64 = await this.crypto.rsaDecrypt(
			encryptedVaultKey,
			privateKeyPEM,
		);
		return base64ToArrayBuffer(vaultKeyBase64);
	}

	// ============================================================================
	// Desktop-Specific Methods (not in IStorageAdapter interface)
	// ============================================================================

	/**
	 * Get the legacy global server URL (for migration purposes)
	 */
	async getLegacyServerUrl(): Promise<string | null> {
		const store = await this.getStore();
		return (await store.get<string>(LEGACY_SERVER_URL_STORAGE)) ?? null;
	}

	/**
	 * Clear the legacy global server URL (after migration)
	 */
	async clearLegacyServerUrl(): Promise<void> {
		const store = await this.getStore();
		await store.delete(LEGACY_SERVER_URL_STORAGE);
		await store.save();
	}

	/**
	 * Clear server URL for an account
	 */
	async clearServerUrl(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "server_url");
		await store.delete(key);
		await store.save();
	}

	/**
	 * Store a custom web app URL for an account
	 */
	async storeWebAppUrl(webAppUrl: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "web_app_url");
		await store.set(key, webAppUrl);
		await store.save();
	}

	/**
	 * Get the custom web app URL for an account
	 */
	async getWebAppUrl(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "web_app_url");
		return (await store.get<string>(key)) ?? null;
	}

	/**
	 * Clear the custom web app URL for an account
	 */
	async clearWebAppUrl(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "web_app_url");
		await store.delete(key);
		await store.save();
	}

	/**
	 * Get the effective web app URL for generating share links
	 */
	async getEffectiveWebAppUrl(email?: string): Promise<string> {
		const customUrl = await this.getWebAppUrl(email);
		if (customUrl) {
			return customUrl.replace(/\/$/, "");
		}

		const serverUrl = await this.getServerUrl(email);
		if (serverUrl) {
			return serverUrl.replace(/\/api.*$/, "").replace(/\/$/, "");
		}

		return "https://app.bittery.io";
	}

	/**
	 * Clear auto-lock timeout preference for an account
	 */
	async clearAutoLockTimeout(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
		await store.delete(key);
		await store.save();
	}

	/**
	 * Get stored session data (public method for desktop)
	 */
	async getStoredSessionData(
		email?: string,
	): Promise<StoredSessionData | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		try {
			const store = await this.getStore();
			const key = getAccountKey(resolvedEmail, "session_data");
			const stored = await store.get<string>(key);

			if (!stored) return null;
			return JSON.parse(stored) as StoredSessionData;
		} catch {
			return null;
		}
	}

	/**
	 * Unlock with biometric authentication
	 */
	async unlockWithBiometric(email?: string): Promise<boolean> {
		try {
			const resolvedEmail = await this.resolveEmail(email);
			if (!resolvedEmail) return false;

			if (!(await this.canBiometricUnlock(resolvedEmail))) {
				return false;
			}

			const masterUnlockKey = await this.decryptStoredMasterUnlockKey(
				resolvedEmail,
				false,
			);
			if (!masterUnlockKey) {
				return false;
			}

			await this.setMasterUnlockKey(masterUnlockKey, resolvedEmail);
			return true;
		} catch (error) {
			console.error("[storage-tauri] Biometric unlock failed:", error);
			return false;
		}
	}

	/**
	 * Lock all accounts (clear all in-memory caches and biometric auth timestamps)
	 */
	async lockAllAccounts(): Promise<void> {
		accountCaches.clear();

		// Clear last biometric auth timestamp for all accounts so biometric is required on next unlock
		const store = await this.getStore();
		const accountsList = await this.getAccountsList();
		for (const account of accountsList) {
			const key = getAccountKey(account.email, "last_biometric_auth");
			await store.delete(key);
		}
		await store.save();
	}

	/**
	 * Check if Secret Key is stored
	 */
	async hasStoredSecretKey(email?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey(email);
		return secretKey != null;
	}

	/**
	 * Clear stored session data from disk
	 */
	async clearStoredSession(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const store = await this.getStore();
		await store.delete(getAccountKey(resolvedEmail, "session_data"));
		await store.delete(getAccountKey(resolvedEmail, "last_biometric_auth"));
		await store.save();
	}

	/**
	 * Get metadata for a specific account
	 */
	async getAccountMetadata(email: string): Promise<AccountMetadata | null> {
		const accountsList = await this.getAccountsList();
		return (
			accountsList.find((a) => a.email.toLowerCase() === email.toLowerCase()) ??
			null
		);
	}

	/**
	 * Get time until session expires (in milliseconds)
	 */
	async getTimeUntilExpiry(email?: string): Promise<number | null> {
		const sessionData = await this.getStoredSessionData(email);
		if (!sessionData) return null;

		const now = Date.now();
		const timeLeft = sessionData.expiresAt - now;
		return timeLeft > 0 ? timeLeft : 0;
	}

	/**
	 * Clear all data for a specific account
	 */
	async clearAccountData(email: string): Promise<void> {
		await this.removeAccount(email);
	}

	// Aliases for backward compatibility
	async storeMasterUnlockKey(key: Uint8Array, email?: string): Promise<void> {
		return this.setMasterUnlockKey(key, email);
	}

	async addAccountToList(metadata: AccountMetadata): Promise<void> {
		return this.addAccount(metadata);
	}

	async removeAccountFromList(email: string): Promise<void> {
		// Note: This only removes from list, not all account data
		const store = await this.getStore();
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.email.toLowerCase() !== email.toLowerCase(),
		);
		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		await store.save();
	}
}

/**
 * Create a new Tauri Storage Adapter instance
 * @param crypto - CryptoProvider implementation for encryption operations
 */
export function createTauriStorageAdapter(
	crypto: CryptoProvider,
): IStorageAdapter {
	return new TauriStorageAdapter(crypto);
}
