/**
 * React Native Storage Adapter with Biometric Authentication
 * Uses expo-secure-store and expo-sqlite for storage, expo-local-authentication for biometrics
 */
/** biome-ignore-all lint/style/noNonNullAssertion: Wee need that here */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import type { EncryptedData } from "@bittery/types";
import type * as CryptoType from "expo-crypto";
import type * as LocalAuthenticationType from "expo-local-authentication";
import type * as SecureStoreType from "expo-secure-store";
import type * as SQLiteType from "expo-sqlite";
import type { IStorageAdapter } from "../adapter";
import type { CryptoProvider } from "../crypto-provider";
import {
	type AccountMetadata,
	type ActiveAccount,
	BIOMETRIC_GRACE_PERIOD_MS,
	type BiometricAuthResult,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	MASTER_PASSWORD_REENTRY_PERIOD_MS,
	type StoredSessionData,
	type VaultKeyData,
} from "../types";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_STORAGE = "bittery_device_key";
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";
const AUTO_LOCK_TIMEOUT_GLOBAL_KEY = "bittery_auto_lock_timeout_global";
const BIOMETRIC_ENABLED_GLOBAL_KEY = "bittery_biometric_enabled_global";
const BACKGROUND_TIMESTAMP_GLOBAL_KEY = "bittery_background_timestamp_global";

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
 * React Native Storage Adapter Implementation
 */
export class ReactNativeStorageAdapter implements IStorageAdapter {
	readonly platform = "mobile" as const;
	readonly supportsMultiAccount = true;
	readonly supportsBiometric = true;

	private SecureStore: typeof SecureStoreType | null = null;
	private SQLite: typeof SQLiteType | null = null;
	private LocalAuthentication: typeof LocalAuthenticationType | null = null;
	private ExpoCrypto: typeof CryptoType | null = null;
	private db: Awaited<ReturnType<typeof SQLiteType.openDatabaseAsync>> | null =
		null;
	private initialized = false;
	private initializePromise: Promise<void> | null = null;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initializePromise) return this.initializePromise;

		this.initializePromise = (async () => {
			// Dynamically import Expo modules
			try {
				this.SecureStore = await import("expo-secure-store");
				this.SQLite = await import("expo-sqlite");
				this.LocalAuthentication = await import("expo-local-authentication");
				this.ExpoCrypto = await import("expo-crypto");

				await this.openAndInitDatabase();
				this.initialized = true;
			} catch (error) {
				this.initializePromise = null;
				console.error("[storage-react-native] Failed to initialize:", error);
				throw error;
			}
		})();

		return this.initializePromise;
	}

	private async openAndInitDatabase(): Promise<void> {
		if (!this.SQLite) {
			throw new Error("SQLite module not initialized");
		}

		const openAndInit = async () => {
			this.db = await this.SQLite!.openDatabaseAsync("bittery.db");
			await this.db.execAsync(`
				CREATE TABLE IF NOT EXISTS kv_store (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
			`);
		};

		try {
			await openAndInit();
		} catch {
			// Retry once to recover from transient native handle issues (e.g. Fast Refresh)
			await openAndInit();
		}
	}

	private async setItem(key: string, value: string): Promise<void> {
		// For sensitive data under 2KB, use SecureStore
		if (value.length < 2000 && this.SecureStore) {
			try {
				await this.SecureStore.setItemAsync(key, value);
				return;
			} catch {
				// Fall back to SQLite
			}
		}

		// Use SQLite for larger data or as fallback
		if (this.db) {
			await this.db.runAsync(
				"INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
				[key, value],
			);
		}
	}

	private async getItem(key: string): Promise<string | null> {
		// Try SecureStore first
		if (this.SecureStore) {
			try {
				const value = await this.SecureStore.getItemAsync(key);
				if (value !== null) return value;
			} catch {
				// Fall back to SQLite
			}
		}

		// Try SQLite
		if (this.db) {
			const result = await this.db.getFirstAsync<{ value: string }>(
				"SELECT value FROM kv_store WHERE key = ?",
				[key],
			);
			return result?.value ?? null;
		}

		return null;
	}

	private async deleteItem(key: string): Promise<void> {
		if (this.SecureStore) {
			try {
				await this.SecureStore.deleteItemAsync(key);
			} catch {
				// Ignore
			}
		}

		if (this.db) {
			await this.db.runAsync("DELETE FROM kv_store WHERE key = ?", [key]);
		}
	}

	private async resolveEmail(email?: string): Promise<string | null> {
		if (email) return email.toLowerCase();

		const account = await this.getActiveAccount();
		if (!account || account.type === "all") return null;
		return account.email;
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
		const stored = await this.getItem(DEVICE_KEY_STORAGE);

		if (stored) {
			return base64ToArrayBuffer(stored);
		}

		// Generate new device key using expo-crypto
		if (!this.ExpoCrypto) {
			throw new Error("Crypto module not initialized");
		}
		const deviceKey = this.ExpoCrypto.getRandomBytes(32);
		await this.setItem(DEVICE_KEY_STORAGE, arrayBufferToBase64(deviceKey));
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
			const restored = await this.decryptStoredMasterUnlockKeyInternal(
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
		sessionId?: string,
	): Promise<void> {
		const resolvedEmail = email.toLowerCase();
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
			sessionId,
			expiresAt: now + expiryMs,
			createdAt: now,
			biometricEnabled,
			lastMasterPasswordEntry: now,
		};

		const key = getAccountKey(resolvedEmail, "session_data");
		await this.setItem(key, JSON.stringify(sessionData));
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
			console.log("[storage-react-native] Session restored from memory cache");
			return true;
		}

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal(
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

		const key = getAccountKey(resolvedEmail, "secret_key");
		await this.setItem(key, secretKey);
	}

	async getStoredSecretKey(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "secret_key");
		return this.getItem(key);
	}

	async storeAuthToken(token: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedEmail);
		cache.authToken = token;

		const key = getAccountKey(resolvedEmail, "jwt_token");
		await this.setItem(key, token);
	}

	async getAuthToken(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.authToken) {
			return cache.authToken;
		}

		const key = getAccountKey(resolvedEmail, "jwt_token");
		const token = await this.getItem(key);
		if (token) {
			cache.authToken = token;
		}
		return token;
	}

	async storeVaultKeys(
		vaultKeys: VaultKeyData[],
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		console.log(
			"[storage-react-native] Storing vault keys:",
			vaultKeys.length,
			"keys",
		);

		const cache = this.getAccountCache(resolvedEmail);
		cache.vaultKeys = vaultKeys;

		const key = getAccountKey(resolvedEmail, "vault_keys");
		await this.setItem(key, JSON.stringify(vaultKeys));
	}

	async getVaultKeys(email?: string): Promise<VaultKeyData[] | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.vaultKeys) {
			return cache.vaultKeys;
		}

		const key = getAccountKey(resolvedEmail, "vault_keys");
		const stored = await this.getItem(key);
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

		const key = getAccountKey(resolvedEmail, "encrypted_private_key");
		await this.setItem(key, encryptedPrivateKey);
	}

	async getEncryptedPrivateKey(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "encrypted_private_key");
		return this.getItem(key);
	}

	// ============================================================================
	// Multi-Account
	// ============================================================================

	async getActiveAccount(): Promise<ActiveAccount> {
		const stored = await this.getItem(ACTIVE_ACCOUNT_KEY);
		if (!stored) return null;
		if (stored === "all") return { type: "all" };
		return { type: "single", email: stored };
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const account = await this.getActiveAccount();
		if (!account || account.type === "all") return null;

		const sessionData = await this.getStoredSessionData(account.email);
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(account: ActiveAccount): Promise<void> {
		const normalizedValue = !account
			? null
			: account.type === "all"
				? "all"
				: account.email.toLowerCase();

		if (normalizedValue) {
			await this.setItem(ACTIVE_ACCOUNT_KEY, normalizedValue);
		} else {
			await this.deleteItem(ACTIVE_ACCOUNT_KEY);
		}

		// Update lastActiveAt if single account
		if (account?.type === "single") {
			const accountsList = await this.getAccountsListInternal();
			const accountMeta = accountsList.accounts.find(
				(a) => a.email.toLowerCase() === account.email.toLowerCase(),
			);
			if (accountMeta) {
				accountMeta.lastActiveAt = Date.now();
				await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
			}
		}
	}

	async getAccountsList(): Promise<AccountMetadata[]> {
		const accountsList = await this.getAccountsListInternal();
		return accountsList.accounts;
	}

	private async getAccountsListInternal(): Promise<AccountsList> {
		const stored = await this.getItem(ACCOUNTS_LIST_KEY);
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
		const accountsList = await this.getAccountsListInternal();

		const existingIndex = accountsList.accounts.findIndex(
			(a) => a.email.toLowerCase() === metadata.email.toLowerCase(),
		);

		if (existingIndex >= 0) {
			accountsList.accounts[existingIndex] = metadata;
		} else {
			accountsList.accounts.push(metadata);
		}

		await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}

	async removeAccount(email: string): Promise<void> {
		const resolvedEmail = email.toLowerCase();

		// Delete all namespaced keys for this account
		await this.deleteItem(getAccountKey(resolvedEmail, "secret_key"));
		await this.deleteItem(getAccountKey(resolvedEmail, "session_data"));
		await this.deleteItem(getAccountKey(resolvedEmail, "jwt_token"));
		await this.deleteItem(getAccountKey(resolvedEmail, "vault_keys"));
		await this.deleteItem(getAccountKey(resolvedEmail, "biometric_enabled"));
		await this.deleteItem(getAccountKey(resolvedEmail, "last_biometric_auth"));
		await this.deleteItem(getAccountKey(resolvedEmail, "server_url"));
		await this.deleteItem(
			getAccountKey(resolvedEmail, "encrypted_private_key"),
		);
		await this.deleteItem(getAccountKey(resolvedEmail, "auto_lock_timeout"));
		await this.deleteItem(getAccountKey(resolvedEmail, "background_timestamp"));

		this.clearAccountCache(resolvedEmail);

		// Remove from accounts list
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.email.toLowerCase() !== resolvedEmail,
		);
		await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(
		timeoutMs: number,
		_email?: string,
	): Promise<void> {
		await this.storeGlobalAutoLockTimeout(timeoutMs);

		const accountsList = await this.getAccountsListInternal();
		for (const account of accountsList.accounts) {
			const key = getAccountKey(account.email, "auto_lock_timeout");
			await this.setItem(key, timeoutMs.toString());
		}
	}

	async getAutoLockTimeout(email?: string): Promise<number | null> {
		const globalValue = await this.getGlobalAutoLockTimeout();
		if (globalValue !== null) return globalValue;

		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
		const stored = await this.getItem(key);
		return stored ? Number.parseInt(stored, 10) : null;
	}

	async getAutoLockTimeoutOrDefault(email?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(email);
		return timeout ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS;
	}

	async storeServerUrl(serverUrl: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const key = getAccountKey(resolvedEmail, "server_url");
		await this.setItem(key, serverUrl);
	}

	async getServerUrl(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "server_url");
		return this.getItem(key);
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
		const key = getAccountKey(resolvedEmail, "last_biometric_auth");
		await this.deleteItem(key);
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
		if (!this.LocalAuthentication) return false;
		try {
			const hasHardware = await this.LocalAuthentication.hasHardwareAsync();
			if (!hasHardware) return false;

			const isEnrolled = await this.LocalAuthentication.isEnrolledAsync();
			return isEnrolled;
		} catch {
			return false;
		}
	}

	async isBiometricEnabled(email?: string): Promise<boolean> {
		const globalEnabled = await this.getGlobalBiometricEnabled();
		if (globalEnabled !== null) return globalEnabled;

		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		const key = getAccountKey(resolvedEmail, "biometric_enabled");
		const enabled = await this.getItem(key);
		return enabled === "true";
	}

	async enableBiometric(email?: string): Promise<void> {
		await this.setGlobalBiometricEnabled(true);
		await this.updateBiometricEnabledForAllAccounts(true);
		if (email) {
			const key = getAccountKey(email, "biometric_enabled");
			await this.setItem(key, "true");
		}
	}

	async disableBiometric(email?: string): Promise<void> {
		await this.setGlobalBiometricEnabled(false);
		await this.updateBiometricEnabledForAllAccounts(false);
		if (email) {
			const key = getAccountKey(email, "biometric_enabled");
			await this.setItem(key, "false");
		}
	}

	async authenticateWithBiometric(
		reason = "Unlock Bittery",
		email?: string,
	): Promise<boolean> {
		if (!this.LocalAuthentication) return false;

		try {
			const resolvedEmail = await this.resolveEmail(email);
			if (!resolvedEmail) return false;

			const result = await this.LocalAuthentication.authenticateAsync({
				promptMessage: reason,
				cancelLabel: "Cancel",
				disableDeviceFallback: false,
				fallbackLabel: "Use Password",
			});

			if (result.success) {
				// Update last biometric auth timestamp
				const key = getAccountKey(resolvedEmail, "last_biometric_auth");
				await this.setItem(key, Date.now().toString());
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

	async canBiometricUnlock(email?: string): Promise<boolean> {
		const available = await this.isBiometricAvailable();
		const enabled = await this.isBiometricEnabled(email);
		const sessionValid = await this.isSessionValid(email);
		return available && enabled && sessionValid;
	}

	async getStoredSessionData(
		email?: string,
	): Promise<StoredSessionData | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		try {
			const key = getAccountKey(resolvedEmail, "session_data");
			const stored = await this.getItem(key);

			if (!stored) return null;
			return JSON.parse(stored) as StoredSessionData;
		} catch {
			return null;
		}
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async getGlobalAutoLockTimeout(): Promise<number | null> {
		const stored = await this.getItem(AUTO_LOCK_TIMEOUT_GLOBAL_KEY);
		return stored ? Number.parseInt(stored, 10) : null;
	}

	private async storeGlobalAutoLockTimeout(timeoutMs: number): Promise<void> {
		await this.setItem(AUTO_LOCK_TIMEOUT_GLOBAL_KEY, timeoutMs.toString());
	}

	private async getGlobalBiometricEnabled(): Promise<boolean | null> {
		const stored = await this.getItem(BIOMETRIC_ENABLED_GLOBAL_KEY);
		if (stored === null) return null;
		return stored === "true";
	}

	private async setGlobalBiometricEnabled(enabled: boolean): Promise<void> {
		await this.setItem(
			BIOMETRIC_ENABLED_GLOBAL_KEY,
			enabled ? "true" : "false",
		);
	}

	private async updateBiometricEnabledForAllAccounts(
		enabled: boolean,
	): Promise<void> {
		const accountsList = await this.getAccountsListInternal();
		let metadataChanged = false;

		for (const account of accountsList.accounts) {
			const key = getAccountKey(account.email, "biometric_enabled");
			await this.setItem(key, enabled ? "true" : "false");

			if (account.biometricEnabled !== enabled) {
				account.biometricEnabled = enabled;
				metadataChanged = true;
			}

			const sessionKey = getAccountKey(account.email, "session_data");
			const storedSession = await this.getItem(sessionKey);
			if (storedSession) {
				try {
					const sessionData = JSON.parse(storedSession) as StoredSessionData;
					sessionData.biometricEnabled = enabled;
					await this.setItem(sessionKey, JSON.stringify(sessionData));
				} catch {
					// Ignore malformed session data
				}
			}
		}

		if (metadataChanged) {
			await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		}
	}

	private async isBiometricAuthRequiredInternal(
		email: string,
	): Promise<boolean> {
		const sessionData = await this.getStoredSessionData(email);
		if (!sessionData || !sessionData.biometricEnabled) {
			return false;
		}

		const key = getAccountKey(email, "last_biometric_auth");
		const lastAuthStr = await this.getItem(key);

		if (!lastAuthStr) {
			return true;
		}

		const lastAuth = Number.parseInt(lastAuthStr, 10);
		const timeSinceLastAuth = Date.now() - lastAuth;
		return timeSinceLastAuth > BIOMETRIC_GRACE_PERIOD_MS;
	}

	private async isMasterPasswordReentryRequiredInternal(
		email: string,
	): Promise<boolean> {
		const sessionData = await this.getStoredSessionData(email);
		if (!sessionData) return true;

		const lastPasswordEntry =
			sessionData.lastMasterPasswordEntry || sessionData.createdAt;
		const timeSinceLastEntry = Date.now() - lastPasswordEntry;
		return timeSinceLastEntry > MASTER_PASSWORD_REENTRY_PERIOD_MS;
	}

	private async decryptStoredMasterUnlockKeyInternal(
		email: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData(email);
		if (!sessionData) return null;

		// Check if master password re-entry is required (periodic security measure)
		if (await this.isMasterPasswordReentryRequiredInternal(email)) {
			return null;
		}

		// Check if biometric authentication is required
		if (!skipBiometric && sessionData.biometricEnabled) {
			const authRequired = await this.isBiometricAuthRequiredInternal(email);
			if (authRequired) {
				const authenticated = await this.authenticateWithBiometric(
					"Unlock your vault",
					email,
				);
				if (!authenticated) {
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
			return base64ToArrayBuffer(mukBase64);
		} catch {
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
	// Mobile-Specific Methods (not in IStorageAdapter interface)
	// ============================================================================

	/**
	 * Get detailed biometric availability information
	 */
	async getBiometricAvailabilityDetails(): Promise<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}> {
		if (!this.LocalAuthentication) {
			return { hasHardware: false, isEnrolled: false };
		}
		try {
			const hasHardware = await this.LocalAuthentication.hasHardwareAsync();
			const isEnrolled = await this.LocalAuthentication.isEnrolledAsync();
			return { hasHardware, isEnrolled };
		} catch {
			return { hasHardware: false, isEnrolled: false };
		}
	}

	/**
	 * Get the type of biometric authentication available (Face ID, Touch ID, Fingerprint)
	 */
	async getBiometricType(): Promise<string | null> {
		if (!this.LocalAuthentication) return null;
		try {
			const types =
				await this.LocalAuthentication.supportedAuthenticationTypesAsync();
			if (
				types.includes(
					this.LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
				)
			) {
				return "Face ID";
			}
			if (
				types.includes(this.LocalAuthentication.AuthenticationType.FINGERPRINT)
			) {
				return "Touch ID";
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Lock all accounts (clear all in-memory caches and biometric auth timestamps)
	 */
	async lockAllAccounts(): Promise<void> {
		accountCaches.clear();

		// Clear last biometric auth timestamp for all accounts so biometric is required on next unlock
		const accountsList = await this.getAccountsList();
		for (const account of accountsList) {
			const key = getAccountKey(account.email, "last_biometric_auth");
			await this.deleteItem(key);
		}
	}

	/**
	 * Unlock all accounts with biometric authentication
	 * Shows ONE biometric prompt and unlocks all accounts that support biometric
	 * Returns { unlocked: string[], failed: Array<{email: string, error: string}> }
	 */
	async unlockAllAccountsWithBiometric(): Promise<{
		unlocked: string[];
		failed: Array<{ email: string; error: string }>;
	}> {
		const accountsList = await this.getAccountsList();
		const unlocked: string[] = [];
		const failed: Array<{ email: string; error: string }> = [];

		if (accountsList.length === 0) {
			return { unlocked, failed };
		}

		// Find first account that supports biometric
		let firstAccountEmail: string | null = null;
		for (const account of accountsList) {
			if (await this.canBiometricUnlock(account.email)) {
				firstAccountEmail = account.email;
				break;
			}
		}

		if (!firstAccountEmail) {
			for (const account of accountsList) {
				failed.push({
					email: account.email,
					error: "Biometric authentication not available",
				});
			}
			return { unlocked, failed };
		}

		const authenticated = await this.authenticateWithBiometric(
			"Unlock all accounts",
			firstAccountEmail,
		);

		if (!authenticated) {
			for (const account of accountsList) {
				failed.push({
					email: account.email,
					error: "Biometric authentication failed or cancelled",
				});
			}
			return { unlocked, failed };
		}

		for (const account of accountsList) {
			try {
				const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal(
					account.email,
					true,
				);
				if (masterUnlockKey) {
					await this.setMasterUnlockKey(masterUnlockKey, account.email);
					unlocked.push(account.email);
				} else {
					failed.push({
						email: account.email,
						error: "Could not decrypt session data",
					});
				}
			} catch (error) {
				failed.push({
					email: account.email,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return { unlocked, failed };
	}

	/**
	 * Check if Secret Key is stored
	 */
	async hasStoredSecretKey(email?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey(email);
		return secretKey != null;
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
	 * Get list of unlocked account emails (accounts with MUK currently in memory)
	 */
	async getUnlockedAccounts(): Promise<string[]> {
		const unlockedEmails: string[] = [];
		for (const [email, cache] of accountCaches.entries()) {
			if (cache.masterUnlockKey) {
				unlockedEmails.push(email);
			}
		}
		return unlockedEmails;
	}

	/**
	 * Check if master password re-entry is required (periodic security measure)
	 */
	async isMasterPasswordReentryRequired(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return true;

		const sessionData = await this.getStoredSessionData(resolvedEmail);
		if (!sessionData) return true;

		const lastPasswordEntry =
			sessionData.lastMasterPasswordEntry || sessionData.createdAt;
		const timeSinceLastEntry = Date.now() - lastPasswordEntry;
		return timeSinceLastEntry > MASTER_PASSWORD_REENTRY_PERIOD_MS;
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

			const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal(
				resolvedEmail,
				false,
			);
			if (!masterUnlockKey) {
				return false;
			}

			await this.setMasterUnlockKey(masterUnlockKey, resolvedEmail);
			return true;
		} catch (error) {
			console.error("[storage-react-native] Biometric unlock failed:", error);
			return false;
		}
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
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.email.toLowerCase() !== email.toLowerCase(),
		);
		await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}

	async clearAccountData(email: string): Promise<void> {
		await this.removeAccount(email);
	}

	/**
	 * Store the timestamp when app went to background
	 */
	async storeBackgroundTimestamp(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const key = getAccountKey(resolvedEmail, "background_timestamp");
		await this.setItem(key, Date.now().toString());
	}

	/**
	 * Store the global timestamp when app went to background (all-accounts mode)
	 */
	async storeBackgroundTimestampGlobal(): Promise<void> {
		await this.setItem(BACKGROUND_TIMESTAMP_GLOBAL_KEY, Date.now().toString());
	}

	/**
	 * Get the timestamp when app went to background
	 */
	async getBackgroundTimestamp(email?: string): Promise<number | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "background_timestamp");
		const timestamp = await this.getItem(key);
		return timestamp ? Number.parseInt(timestamp, 10) : null;
	}

	/**
	 * Get the global background timestamp (all-accounts mode)
	 */
	async getBackgroundTimestampGlobal(): Promise<number | null> {
		const timestamp = await this.getItem(BACKGROUND_TIMESTAMP_GLOBAL_KEY);
		return timestamp ? Number.parseInt(timestamp, 10) : null;
	}

	/**
	 * Clear the background timestamp
	 */
	async clearBackgroundTimestamp(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const key = getAccountKey(resolvedEmail, "background_timestamp");
		await this.deleteItem(key);
	}

	/**
	 * Clear the global background timestamp (all-accounts mode)
	 */
	async clearBackgroundTimestampGlobal(): Promise<void> {
		await this.deleteItem(BACKGROUND_TIMESTAMP_GLOBAL_KEY);
	}

	/**
	 * Check if app should require re-authentication after returning from background
	 */
	async shouldRequireAuthAfterBackground(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		const backgroundTimestamp =
			await this.getBackgroundTimestamp(resolvedEmail);
		if (!backgroundTimestamp) return false;

		const autoLockTimeout =
			await this.getAutoLockTimeoutOrDefault(resolvedEmail);

		// If auto-lock is set to "Never" (-1), don't require re-auth
		if (autoLockTimeout === -1) return false;

		const timeSinceBackground = Date.now() - backgroundTimestamp;
		return timeSinceBackground > autoLockTimeout;
	}

	/**
	 * Check if app should require re-authentication after returning from background (global)
	 */
	async shouldRequireAuthAfterBackgroundGlobal(): Promise<boolean> {
		const backgroundTimestamp = await this.getBackgroundTimestampGlobal();
		if (!backgroundTimestamp) return false;

		const autoLockTimeout = await this.getAutoLockTimeoutOrDefault();
		if (autoLockTimeout === -1) return false;

		const timeSinceBackground = Date.now() - backgroundTimestamp;
		return timeSinceBackground > autoLockTimeout;
	}

	/**
	 * Check if biometric authentication is required (public wrapper)
	 */
	async isBiometricAuthRequiredPublic(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;
		return this.isBiometricAuthRequiredInternal(resolvedEmail);
	}

	/**
	 * Decrypt stored master unlock key (interface method)
	 */
	async decryptStoredMasterUnlockKey(
		email?: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;
		return this.decryptStoredMasterUnlockKeyInternal(
			resolvedEmail,
			skipBiometric,
		);
	}

	/**
	 * @deprecated Use decryptStoredMasterUnlockKey instead
	 */
	async decryptStoredMasterUnlockKeyPublic(
		email?: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		return this.decryptStoredMasterUnlockKey(email, skipBiometric);
	}

	/**
	 * Update the last master password entry timestamp (for 30-day re-entry requirement)
	 */
	async updateLastMasterPasswordEntry(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const sessionData = await this.getStoredSessionData(resolvedEmail);
		if (!sessionData) return;

		sessionData.lastMasterPasswordEntry = Date.now();

		const key = getAccountKey(resolvedEmail, "session_data");
		await this.setItem(key, JSON.stringify(sessionData));
	}

	/**
	 * Enhanced biometric authentication with detailed error handling
	 */
	async authenticateWithBiometricEnhanced(
		reason = "Unlock Bittery",
		email?: string,
	): Promise<BiometricAuthResult> {
		try {
			const resolvedEmail = await this.resolveEmail(email);
			if (!resolvedEmail) {
				return {
					success: false,
					error: "unknown",
					message: "No account specified",
				};
			}

			// Check hardware availability
			if (!this.LocalAuthentication) {
				return {
					success: false,
					error: "not_available",
					message: "Biometric authentication not available",
				};
			}

			const hasHardware = await this.LocalAuthentication.hasHardwareAsync();
			if (!hasHardware) {
				return {
					success: false,
					error: "not_available",
					message: "This device does not support biometric authentication",
				};
			}

			// Check if biometrics are enrolled
			const isEnrolled = await this.LocalAuthentication.isEnrolledAsync();
			if (!isEnrolled) {
				return {
					success: false,
					error: "not_enrolled",
					message:
						"No biometrics enrolled. Please set up Face ID or Touch ID in your device settings",
				};
			}

			// Check if biometric is enabled for this account
			const isEnabled = await this.isBiometricEnabled(resolvedEmail);
			if (!isEnabled) {
				return {
					success: false,
					error: "not_enabled",
					message: "Biometric authentication is not enabled for this account",
				};
			}

			// Check if master password re-entry is required
			if (await this.isMasterPasswordReentryRequiredInternal(resolvedEmail)) {
				return {
					success: false,
					error: "master_password_required",
					message:
						"For your security, please enter your master password. This is required periodically.",
				};
			}

			// Check if session is valid
			if (!(await this.isSessionValid(resolvedEmail))) {
				return {
					success: false,
					error: "session_expired",
					message: "Your session has expired. Please log in again",
				};
			}

			const result = await this.LocalAuthentication.authenticateAsync({
				promptMessage: reason,
				cancelLabel: "Cancel",
				disableDeviceFallback: false,
				fallbackLabel: "Use Password",
			});

			if (result.success) {
				// Update last biometric auth timestamp
				const key = getAccountKey(resolvedEmail, "last_biometric_auth");
				await this.setItem(key, Date.now().toString());

				// Clear background timestamp on successful auth
				await this.clearBackgroundTimestamp(resolvedEmail);

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
				"[storage-react-native] Biometric authentication error:",
				error,
			);
			return {
				success: false,
				error: "unknown",
				message:
					error instanceof Error ? error.message : "Unknown error occurred",
			};
		}
	}
}

/**
 * Create a new React Native Storage Adapter instance
 * @param crypto - CryptoProvider implementation for encryption operations
 */
export function createReactNativeStorageAdapter(
	crypto: CryptoProvider,
): ReactNativeStorageAdapter {
	return new ReactNativeStorageAdapter(crypto);
}
