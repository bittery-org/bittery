/**
 * React Native Storage Adapter with Biometric Authentication
 * Uses expo-secure-store and expo-sqlite for storage, expo-local-authentication for biometrics
 */
/** biome-ignore-all lint/style/noNonNullAssertion: Wee need that here */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemCacheMetadata,
	KdfParams,
} from "@bittery/types";
import * as CryptoType from "expo-crypto";
import * as LocalAuthenticationType from "expo-local-authentication";
import * as SecureStoreType from "expo-secure-store";
import * as SQLiteType from "expo-sqlite";
import {
	findAccountById,
	findAccountByServerUser,
	generateAccountId,
} from "../account-id";
import {
	ACCOUNT_STORAGE_SUFFIXES,
	getAccountKey,
	getLegacyAccountKey,
} from "../account-keys";
import type { IStorageAdapter } from "../adapter";
import type { CryptoProvider } from "../crypto-provider";
import {
	migrateEmailKeysToAccountIds,
	parseStoredActiveAccount,
	serializeActiveAccount,
} from "../migrate-to-account-ids";
import { resolveStoredSessionExpiryTimestamp } from "../session";
import {
	type AccountMetadata,
	type ActiveAccount,
	BIOMETRIC_GRACE_PERIOD_MS,
	type BiometricAuthResult,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	MASTER_PASSWORD_REENTRY_PERIOD_MS,
	type StoredSessionData,
	type TravelModeConfig,
	type VaultKeyData,
} from "../types";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_STORAGE = "bittery_device_key";
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";
const AUTO_LOCK_TIMEOUT_GLOBAL_KEY = "bittery_auto_lock_timeout_global";
const BIOMETRIC_ENABLED_GLOBAL_KEY = "bittery_biometric_enabled_global";

function isSecureStoreOnlyKey(key: string): boolean {
	return (
		key === DEVICE_KEY_STORAGE ||
		key.endsWith("_session_data") ||
		key.endsWith("_jwt_token")
	);
}

interface AccountsList {
	accounts: AccountMetadata[];
}

// Per-account cache structure
interface AccountCache {
	authToken: string | null;
	vaultKeys: VaultKeyData[] | null;
	masterUnlockKey: Uint8Array | null;
	cachedItems: CachedEncryptedItem[] | null;
	cachedVaults: CachedVaultMetadata[] | null;
}

// In-memory caches - keyed by accountId
const accountCaches: Map<string, AccountCache> = new Map();

/**
 * React Native Storage Adapter Implementation
 */
export class ReactNativeStorageAdapter implements IStorageAdapter {
	readonly platform = "mobile" as const;
	readonly supportsMultiAccount = true;
	readonly supportsBiometric = true;
	readonly supportsItemCache = true;

	private SecureStore: typeof SecureStoreType = SecureStoreType;
	private SQLite: typeof SQLiteType = SQLiteType;
	private LocalAuthentication: typeof LocalAuthenticationType =
		LocalAuthenticationType;
	private ExpoCrypto: typeof CryptoType = CryptoType;
	private db: Awaited<ReturnType<typeof SQLiteType.openDatabaseAsync>> | null =
		null;
	private initialized = false;
	private initializePromise: Promise<void> | null = null;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initializePromise) return this.initializePromise;

		this.initializePromise = (async () => {
			try {
				await this.openAndInitDatabase();

				// Migrate legacy email-keyed storage to accountId keys
				await migrateEmailKeysToAccountIds({
					store: {
						get: async <T>(key: string) => {
							const value = await this.getItem(key);
							if (value === null) return undefined;
							if (value === "true") return true as T;
							if (value === "false") return false as T;
							return value as T;
						},
						set: async (key, value) => {
							if (typeof value === "boolean") {
								await this.setItem(key, value ? "true" : "false");
							} else if (typeof value === "number") {
								await this.setItem(key, value.toString());
							} else if (typeof value === "string") {
								await this.setItem(key, value);
							} else {
								await this.setItem(key, JSON.stringify(value));
							}
						},
						delete: async (key) => {
							await this.deleteItem(key);
						},
					},
					activeAccountKey: ACTIVE_ACCOUNT_KEY,
					accountsListKey: ACCOUNTS_LIST_KEY,
					getAccountsList: async () =>
						(await this.getAccountsListInternal()).accounts,
					saveAccountsList: async (accounts) => {
						await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify({ accounts }));
					},
				});

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
		if (isSecureStoreOnlyKey(key)) {
			if (!this.SecureStore) {
				throw new Error(
					`SecureStore not available for sensitive key write: ${key}`,
				);
			}

			await this.SecureStore.setItemAsync(key, value);

			// Ensure sensitive keys do not remain in SQLite fallback storage.
			if (this.db) {
				await this.db.runAsync("DELETE FROM kv_store WHERE key = ?", [key]);
			}
			return;
		}

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
		if (isSecureStoreOnlyKey(key)) {
			if (!this.SecureStore) {
				console.warn(
					`[storage-react-native] SecureStore unavailable for sensitive key read: ${key}`,
				);
				return null;
			}

			try {
				const secureValue = await this.SecureStore.getItemAsync(key);
				if (secureValue !== null) return secureValue;
			} catch {
				// Continue to migration check from legacy SQLite fallback.
			}

			// Legacy migration: promote historical SQLite value to SecureStore.
			if (this.db) {
				const legacy = await this.db.getFirstAsync<{ value: string }>(
					"SELECT value FROM kv_store WHERE key = ?",
					[key],
				);
				if (legacy?.value != null) {
					try {
						await this.SecureStore.setItemAsync(key, legacy.value);
						await this.db.runAsync("DELETE FROM kv_store WHERE key = ?", [key]);
						return legacy.value;
					} catch (error) {
						console.error(
							"[storage-react-native] Failed migrating sensitive key to SecureStore:",
							error,
						);
						return null;
					}
				}
			}

			return null;
		}

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

	private async resolveAccountId(accountId?: string): Promise<string | null> {
		if (accountId) return accountId;

		const account = await this.getActiveAccount();
		if (!account) return null;
		return account.accountId;
	}

	private getAccountCache(accountId: string): AccountCache {
		let cache = accountCaches.get(accountId);
		if (!cache) {
			cache = {
				authToken: null,
				vaultKeys: null,
				masterUnlockKey: null,
				cachedItems: null,
				cachedVaults: null,
			};
			accountCaches.set(accountId, cache);
		}
		return cache;
	}

	private clearAccountCache(accountId: string): void {
		accountCaches.delete(accountId);
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

	async getMasterUnlockKey(accountId?: string): Promise<Uint8Array | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.masterUnlockKey) {
			return cache.masterUnlockKey;
		}

		// Try to restore from persistent storage if session is still valid
		if (await this.isSessionValid(resolvedAccountId)) {
			const restored = await this.decryptStoredMasterUnlockKeyInternal(
				resolvedAccountId,
				false,
			);
			if (restored) {
				cache.masterUnlockKey = restored;
				return restored;
			}
		}

		return null;
	}

	async setMasterUnlockKey(key: Uint8Array, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedAccountId);
		cache.masterUnlockKey = key;
	}

	async clearMasterUnlockKey(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = this.getAccountCache(resolvedAccountId);
		cache.masterUnlockKey = null;
	}

	async storeSessionData(
		masterUnlockKey: Uint8Array,
		accountId: string,
		email: string,
		userId: string,
		expiresAt?: string | Date | number,
		sessionId?: string,
	): Promise<void> {
		const deviceKey = await this.getDeviceKey();
		const now = Date.now();

		// Encrypt Master Unlock Key with device key
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const encryptedMUK = await this.crypto.encrypt(mukBase64, deviceKey);

		const biometricEnabled =
			(await this.isBiometricEnabled?.(accountId)) ?? false;

		const sessionData: StoredSessionData = {
			encryptedMasterUnlockKey: encryptedMUK,
			email: email.toLowerCase(),
			userId,
			sessionId,
			expiresAt: resolveStoredSessionExpiryTimestamp(expiresAt, now),
			createdAt: now,
			biometricEnabled,
			lastMasterPasswordEntry: now,
		};

		const key = getAccountKey(accountId, "session_data");
		await this.setItem(key, JSON.stringify(sessionData));
	}

	async tryRestoreSession(
		skipBiometric = false,
		accountId?: string,
	): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		if (!(await this.isSessionValid(resolvedAccountId))) {
			return false;
		}

		// First check if MUK is already in memory cache (e.g., after login)
		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.masterUnlockKey) {
			console.log("[storage-react-native] Session restored from memory cache");
			return true;
		}

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal(
			resolvedAccountId,
			skipBiometric,
		);
		if (!masterUnlockKey) {
			return false;
		}

		await this.setMasterUnlockKey(masterUnlockKey, resolvedAccountId);
		return true;
	}

	async isSessionValid(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		const sessionData = await this.getStoredSessionData(resolvedAccountId);
		const token = await this.getAuthToken(resolvedAccountId);
		if (!sessionData || !token) return false;

		const now = Date.now();
		return now < sessionData.expiresAt;
	}

	// ============================================================================
	// Credentials
	// ============================================================================

	async storeSecretKey(secretKey: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const key = getAccountKey(resolvedAccountId, "secret_key");
		await this.setItem(key, secretKey);
	}

	async getStoredSecretKey(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "secret_key");
		return this.getItem(key);
	}

	async storeAuthToken(token: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedAccountId);
		cache.authToken = token;

		const key = getAccountKey(resolvedAccountId, "jwt_token");
		await this.setItem(key, token);
	}

	async getAuthToken(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.authToken) {
			return cache.authToken;
		}

		const key = getAccountKey(resolvedAccountId, "jwt_token");
		const token = await this.getItem(key);
		if (token) {
			cache.authToken = token;
		}
		return token;
	}

	async storeVaultKeys(
		vaultKeys: VaultKeyData[],
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		console.log(
			"[storage-react-native] Storing vault keys:",
			vaultKeys.length,
			"keys",
		);

		const cache = this.getAccountCache(resolvedAccountId);
		cache.vaultKeys = vaultKeys;

		const key = getAccountKey(resolvedAccountId, "vault_keys");
		await this.setItem(key, JSON.stringify(vaultKeys));
	}

	async getVaultKeys(accountId?: string): Promise<VaultKeyData[] | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.vaultKeys) {
			return cache.vaultKeys;
		}

		const key = getAccountKey(resolvedAccountId, "vault_keys");
		const stored = await this.getItem(key);
		if (stored) {
			cache.vaultKeys = JSON.parse(stored);
		}
		return cache.vaultKeys;
	}

	async storeEncryptedPrivateKey(
		encryptedPrivateKey: string,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const key = getAccountKey(resolvedAccountId, "encrypted_private_key");
		await this.setItem(key, encryptedPrivateKey);
	}

	async getEncryptedPrivateKey(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "encrypted_private_key");
		return this.getItem(key);
	}

	async storePinnedKdfParams(
		params: KdfParams,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const key = getAccountKey(resolvedAccountId, "pinned_kdf_params");
		await this.setItem(key, JSON.stringify(params));
	}

	async getPinnedKdfParams(accountId?: string): Promise<KdfParams | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "pinned_kdf_params");
		const stored = await this.getItem(key);
		if (!stored) return null;
		try {
			return JSON.parse(stored) as KdfParams;
		} catch {
			return null;
		}
	}

	async updateStoredSessionMetadata(
		accountId: string,
		metadata: {
			sessionId?: string;
			expiresAt: string | Date | number;
		},
	): Promise<void> {
		const existing = await this.getStoredSessionData(accountId);
		if (!existing) {
			return;
		}

		const key = getAccountKey(accountId, "session_data");
		const next: StoredSessionData = {
			...existing,
			sessionId: metadata.sessionId ?? existing.sessionId,
			expiresAt: resolveStoredSessionExpiryTimestamp(
				metadata.expiresAt,
				existing.createdAt,
			),
		};
		await this.setItem(key, JSON.stringify(next));
	}

	// ============================================================================
	// Multi-Account
	// ============================================================================

	async getActiveAccount(): Promise<ActiveAccount> {
		const stored = await this.getItem(ACTIVE_ACCOUNT_KEY);
		return parseStoredActiveAccount(stored);
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const account = await this.getActiveAccount();
		if (!account) return null;

		const sessionData = await this.getStoredSessionData(account.accountId);
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(account: ActiveAccount): Promise<void> {
		const normalizedValue = serializeActiveAccount(account);

		if (normalizedValue) {
			await this.setItem(ACTIVE_ACCOUNT_KEY, normalizedValue);
		} else {
			await this.deleteItem(ACTIVE_ACCOUNT_KEY);
		}

		// Update lastActiveAt if single account
		if (account?.type === "single") {
			const accountsList = await this.getAccountsListInternal();
			const accountMeta = findAccountById(
				accountsList.accounts,
				account.accountId,
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

		const accountWithId: AccountMetadata = metadata.accountId
			? metadata
			: { ...metadata, accountId: generateAccountId() };

		const existingByServerUser =
			accountWithId.serverUrl && accountWithId.userId
				? findAccountByServerUser(
						accountsList.accounts,
						accountWithId.serverUrl,
						accountWithId.userId,
					)
				: undefined;

		const existingById = findAccountById(
			accountsList.accounts,
			accountWithId.accountId,
		);

		const existing = existingById ?? existingByServerUser;

		if (existing) {
			const existingIndex = accountsList.accounts.findIndex(
				(a) => a.accountId === existing.accountId,
			);
			accountsList.accounts[existingIndex] = {
				...accountWithId,
				accountId: existing.accountId,
			};
		} else {
			accountsList.accounts.push(accountWithId);
		}

		await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}

	async removeAccount(accountId: string): Promise<void> {
		// Delete all namespaced keys for this account. Iterating the shared
		// ACCOUNT_STORAGE_SUFFIXES keeps removal complete as suffixes are added.
		for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
			await this.deleteItem(getAccountKey(accountId, suffix));
		}

		this.clearAccountCache(accountId);

		// Remove from accounts list
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.accountId !== accountId,
		);
		await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(
		timeoutMs: number,
		_accountId?: string,
	): Promise<void> {
		await this.storeGlobalAutoLockTimeout(timeoutMs);

		const accountsList = await this.getAccountsListInternal();
		for (const account of accountsList.accounts) {
			const key = getAccountKey(account.accountId, "auto_lock_timeout");
			await this.setItem(key, timeoutMs.toString());
		}
	}

	async getAutoLockTimeout(accountId?: string): Promise<number | null> {
		const globalValue = await this.getGlobalAutoLockTimeout();
		if (globalValue !== null) return globalValue;

		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "auto_lock_timeout");
		const stored = await this.getItem(key);
		if (stored) {
			return Number.parseInt(stored, 10);
		}

		// Legacy migration: account-scoped email-keyed timeout
		const accountsList = await this.getAccountsListInternal();
		const account = findAccountById(accountsList.accounts, resolvedAccountId);
		if (account) {
			const legacyKey = getLegacyAccountKey(
				account.email.toLowerCase(),
				"auto_lock_timeout",
			);
			const legacyStored = await this.getItem(legacyKey);
			if (legacyStored) {
				return Number.parseInt(legacyStored, 10);
			}
		}

		return null;
	}

	async getAutoLockTimeoutOrDefault(accountId?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(accountId);
		return timeout ?? DEFAULT_AUTO_LOCK_TIMEOUT_MS;
	}

	async storeServerUrl(serverUrl: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const key = getAccountKey(resolvedAccountId, "server_url");
		await this.setItem(key, serverUrl);
	}

	async getServerUrl(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "server_url");
		return this.getItem(key);
	}

	// ============================================================================
	// Auth State
	// ============================================================================

	async isAuthenticated(accountId?: string): Promise<boolean> {
		const token = await this.getAuthToken(accountId);
		return token != null;
	}

	async canQuickUnlock(accountId?: string): Promise<boolean> {
		const hasSecretKey = (await this.getStoredSecretKey(accountId)) !== null;
		const sessionValid = await this.isSessionValid(accountId);
		return hasSecretKey && sessionValid;
	}

	// ============================================================================
	// Clear
	// ============================================================================

	async clearSession(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		this.clearAccountCache(resolvedAccountId);

		// Clear last biometric auth timestamp so biometric is required on next unlock
		const key = getAccountKey(resolvedAccountId, "last_biometric_auth");
		await this.deleteItem(key);
	}

	async clearAllStoredData(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (resolvedAccountId) {
			await this.removeAccount(resolvedAccountId);
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

	async isBiometricEnabled(accountId?: string): Promise<boolean> {
		const globalEnabled = await this.getGlobalBiometricEnabled();
		if (globalEnabled !== null) return globalEnabled;

		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		const key = getAccountKey(resolvedAccountId, "biometric_enabled");
		const enabled = await this.getItem(key);
		return enabled === "true";
	}

	async enableBiometric(accountId?: string): Promise<void> {
		await this.setGlobalBiometricEnabled(true);
		await this.updateBiometricEnabledForAllAccounts(true);
		if (accountId) {
			const key = getAccountKey(accountId, "biometric_enabled");
			await this.setItem(key, "true");
		}
	}

	async disableBiometric(accountId?: string): Promise<void> {
		await this.setGlobalBiometricEnabled(false);
		await this.updateBiometricEnabledForAllAccounts(false);
		if (accountId) {
			const key = getAccountKey(accountId, "biometric_enabled");
			await this.setItem(key, "false");
		}
	}

	async authenticateWithBiometric(
		reason = "Unlock Bittery",
		accountId?: string,
	): Promise<boolean> {
		if (!this.LocalAuthentication) return false;

		try {
			const resolvedAccountId = await this.resolveAccountId(accountId);
			if (!resolvedAccountId) return false;

			const result = await this.LocalAuthentication.authenticateAsync({
				promptMessage: reason,
				cancelLabel: "Cancel",
				disableDeviceFallback: false,
				fallbackLabel: "Use Password",
			});

			if (result.success) {
				// Update last biometric auth timestamp
				const key = getAccountKey(resolvedAccountId, "last_biometric_auth");
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

	async canBiometricUnlock(accountId?: string): Promise<boolean> {
		const available = await this.isBiometricAvailable();
		const enabled = await this.isBiometricEnabled(accountId);
		const sessionValid = await this.isSessionValid(accountId);
		return available && enabled && sessionValid;
	}

	async getStoredSessionData(
		accountId?: string,
	): Promise<StoredSessionData | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		try {
			const key = getAccountKey(resolvedAccountId, "session_data");
			const stored = await this.getItem(key);

			if (!stored) return null;
			const parsed = JSON.parse(stored) as StoredSessionData;
			return {
				...parsed,
				expiresAt: resolveStoredSessionExpiryTimestamp(
					parsed.expiresAt,
					parsed.createdAt,
				),
			};
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
			const key = getAccountKey(account.accountId, "biometric_enabled");
			await this.setItem(key, enabled ? "true" : "false");

			if (account.biometricEnabled !== enabled) {
				account.biometricEnabled = enabled;
				metadataChanged = true;
			}

			const sessionKey = getAccountKey(account.accountId, "session_data");
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
		accountId: string,
	): Promise<boolean> {
		const sessionData = await this.getStoredSessionData(accountId);
		if (!sessionData || !sessionData.biometricEnabled) {
			return false;
		}

		const key = getAccountKey(accountId, "last_biometric_auth");
		const lastAuthStr = await this.getItem(key);

		if (!lastAuthStr) {
			return true;
		}

		const lastAuth = Number.parseInt(lastAuthStr, 10);
		const timeSinceLastAuth = Date.now() - lastAuth;
		return timeSinceLastAuth > BIOMETRIC_GRACE_PERIOD_MS;
	}

	private async isMasterPasswordReentryRequiredInternal(
		accountId: string,
	): Promise<boolean> {
		const sessionData = await this.getStoredSessionData(accountId);
		if (!sessionData) return true;

		const lastPasswordEntry =
			sessionData.lastMasterPasswordEntry || sessionData.createdAt;
		const timeSinceLastEntry = Date.now() - lastPasswordEntry;
		return timeSinceLastEntry > MASTER_PASSWORD_REENTRY_PERIOD_MS;
	}

	private async decryptStoredMasterUnlockKeyInternal(
		accountId: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData(accountId);
		if (!sessionData) return null;

		// Check if master password re-entry is required (periodic security measure)
		if (await this.isMasterPasswordReentryRequiredInternal(accountId)) {
			return null;
		}

		// Check if biometric authentication is required
		if (!skipBiometric && sessionData.biometricEnabled) {
			const authRequired =
				await this.isBiometricAuthRequiredInternal(accountId);
			if (authRequired) {
				const authenticated = await this.authenticateWithBiometric(
					"Unlock your vault",
					accountId,
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

	// ============================================================================
	// Item Cache
	// ============================================================================

	async setCachedItems(
		items: CachedEncryptedItem[],
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = this.getAccountCache(resolvedAccountId);
		cache.cachedItems = items;

		const key = getAccountKey(resolvedAccountId, "cached_items");
		await this.setItem(key, JSON.stringify(items));
	}

	async getCachedItems(
		accountId?: string,
	): Promise<CachedEncryptedItem[] | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.cachedItems) {
			return cache.cachedItems;
		}

		const key = getAccountKey(resolvedAccountId, "cached_items");
		const stored = await this.getItem(key);
		if (stored) {
			try {
				cache.cachedItems = JSON.parse(stored);
			} catch {
				return null;
			}
		}
		return cache.cachedItems;
	}

	async upsertCachedItem(
		item: CachedEncryptedItem,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		let items = await this.getCachedItems(resolvedAccountId);
		if (!items) {
			items = [];
		}

		const index = items.findIndex((i) => i.id === item.id);
		if (index >= 0) {
			items[index] = item;
		} else {
			items.push(item);
		}

		await this.setCachedItems(items, resolvedAccountId);
	}

	async removeCachedItem(itemId: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const items = await this.getCachedItems(resolvedAccountId);
		if (!items) return;

		const filtered = items.filter((i) => i.id !== itemId);
		await this.setCachedItems(filtered, resolvedAccountId);
	}

	async setCachedVaults(
		vaults: CachedVaultMetadata[],
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = this.getAccountCache(resolvedAccountId);
		cache.cachedVaults = vaults;

		const key = getAccountKey(resolvedAccountId, "cached_vaults");
		await this.setItem(key, JSON.stringify(vaults));
	}

	async getCachedVaults(
		accountId?: string,
	): Promise<CachedVaultMetadata[] | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.cachedVaults) {
			return cache.cachedVaults;
		}

		const key = getAccountKey(resolvedAccountId, "cached_vaults");
		const stored = await this.getItem(key);
		if (stored) {
			try {
				cache.cachedVaults = JSON.parse(stored);
			} catch {
				return null;
			}
		}
		return cache.cachedVaults;
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		let vaults = await this.getCachedVaults(resolvedAccountId);
		if (!vaults) {
			vaults = [];
		}

		const index = vaults.findIndex((v) => v.id === vault.id);
		if (index >= 0) {
			vaults[index] = vault;
		} else {
			vaults.push(vault);
		}

		await this.setCachedVaults(vaults, resolvedAccountId);
	}

	async removeCachedVault(vaultId: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		// Remove the vault metadata
		const vaults = await this.getCachedVaults(resolvedAccountId);
		if (vaults) {
			const filtered = vaults.filter((v) => v.id !== vaultId);
			await this.setCachedVaults(filtered, resolvedAccountId);
		}

		// Also remove all items belonging to this vault
		const items = await this.getCachedItems(resolvedAccountId);
		if (items) {
			const filtered = items.filter((i) => i.vaultId !== vaultId);
			await this.setCachedItems(filtered, resolvedAccountId);
		}
	}

	async getItemCacheMetadata(
		accountId?: string,
	): Promise<ItemCacheMetadata | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "item_cache_meta");
		const stored = await this.getItem(key);
		if (!stored) return null;

		try {
			return JSON.parse(stored) as ItemCacheMetadata;
		} catch {
			return null;
		}
	}

	async setItemCacheMetadata(
		metadata: ItemCacheMetadata,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const key = getAccountKey(resolvedAccountId, "item_cache_meta");
		await this.setItem(key, JSON.stringify(metadata));
	}

	async clearItemCache(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = this.getAccountCache(resolvedAccountId);
		cache.cachedItems = null;
		cache.cachedVaults = null;

		await this.deleteItem(getAccountKey(resolvedAccountId, "cached_items"));
		await this.deleteItem(getAccountKey(resolvedAccountId, "cached_vaults"));
		await this.deleteItem(getAccountKey(resolvedAccountId, "item_cache_meta"));
	}

	async storeTravelModeCache(
		config: TravelModeConfig,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const key = getAccountKey(resolvedAccountId, "travel_mode_cache");
		await this.setItem(key, JSON.stringify(config));
	}

	async getTravelModeCache(
		accountId?: string,
	): Promise<TravelModeConfig | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "travel_mode_cache");
		const stored = await this.getItem(key);
		if (!stored) return null;
		try {
			return JSON.parse(stored) as TravelModeConfig;
		} catch {
			return null;
		}
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
			const key = getAccountKey(account.accountId, "last_biometric_auth");
			await this.deleteItem(key);
		}
	}

	/**
	 * Unlock all accounts with biometric authentication
	 * Shows ONE biometric prompt and unlocks all accounts that support biometric
	 * Returns { unlocked: string[], failed: Array<{accountId: string, error: string}> }
	 */
	async unlockAllAccountsWithBiometric(): Promise<{
		unlocked: string[];
		failed: Array<{ accountId: string; error: string }>;
	}> {
		const accountsList = await this.getAccountsList();
		const unlocked: string[] = [];
		const failed: Array<{ accountId: string; error: string }> = [];

		if (accountsList.length === 0) {
			return { unlocked, failed };
		}

		// Find first account that supports biometric
		let firstAccountId: string | null = null;
		for (const account of accountsList) {
			if (await this.canBiometricUnlock(account.accountId)) {
				firstAccountId = account.accountId;
				break;
			}
		}

		if (!firstAccountId) {
			for (const account of accountsList) {
				failed.push({
					accountId: account.accountId,
					error: "Biometric authentication not available",
				});
			}
			return { unlocked, failed };
		}

		const authenticated = await this.authenticateWithBiometric(
			"Unlock all accounts",
			firstAccountId,
		);

		if (!authenticated) {
			for (const account of accountsList) {
				failed.push({
					accountId: account.accountId,
					error: "Biometric authentication failed or cancelled",
				});
			}
			return { unlocked, failed };
		}

		for (const account of accountsList) {
			try {
				const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal(
					account.accountId,
					true,
				);
				if (masterUnlockKey) {
					await this.setMasterUnlockKey(masterUnlockKey, account.accountId);
					unlocked.push(account.accountId);
				} else {
					failed.push({
						accountId: account.accountId,
						error: "Could not decrypt session data",
					});
				}
			} catch (error) {
				failed.push({
					accountId: account.accountId,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return { unlocked, failed };
	}

	/**
	 * Check if Secret Key is stored
	 */
	async hasStoredSecretKey(accountId?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey(accountId);
		return secretKey != null;
	}

	/**
	 * Get metadata for a specific account
	 */
	async getAccountMetadata(accountId: string): Promise<AccountMetadata | null> {
		const accountsList = await this.getAccountsList();
		return findAccountById(accountsList, accountId) ?? null;
	}

	/**
	 * Get list of unlocked account IDs (accounts with MUK currently in memory)
	 */
	async getUnlockedAccounts(): Promise<string[]> {
		const unlockedAccountIds: string[] = [];
		for (const [accountId, cache] of accountCaches.entries()) {
			if (cache.masterUnlockKey) {
				unlockedAccountIds.push(accountId);
			}
		}
		return unlockedAccountIds;
	}

	/**
	 * Check if master password re-entry is required (periodic security measure)
	 */
	async isMasterPasswordReentryRequired(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return true;

		const sessionData = await this.getStoredSessionData(resolvedAccountId);
		if (!sessionData) return true;

		const lastPasswordEntry =
			sessionData.lastMasterPasswordEntry || sessionData.createdAt;
		const timeSinceLastEntry = Date.now() - lastPasswordEntry;
		return timeSinceLastEntry > MASTER_PASSWORD_REENTRY_PERIOD_MS;
	}

	/**
	 * Unlock with biometric authentication
	 */
	async unlockWithBiometric(accountId?: string): Promise<boolean> {
		try {
			const resolvedAccountId = await this.resolveAccountId(accountId);
			if (!resolvedAccountId) return false;

			if (!(await this.canBiometricUnlock(resolvedAccountId))) {
				return false;
			}

			const masterUnlockKey = await this.decryptStoredMasterUnlockKeyInternal(
				resolvedAccountId,
				false,
			);
			if (!masterUnlockKey) {
				return false;
			}

			await this.setMasterUnlockKey(masterUnlockKey, resolvedAccountId);
			return true;
		} catch (error) {
			console.error("[storage-react-native] Biometric unlock failed:", error);
			return false;
		}
	}

	// Aliases for backward compatibility
	async storeMasterUnlockKey(
		key: Uint8Array,
		accountId?: string,
	): Promise<void> {
		return this.setMasterUnlockKey(key, accountId);
	}

	async addAccountToList(metadata: AccountMetadata): Promise<void> {
		return this.addAccount(metadata);
	}

	async removeAccountFromList(accountId: string): Promise<void> {
		// Note: This only removes from list, not all account data
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.accountId !== accountId,
		);
		await this.setItem(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
	}

	async clearAccountData(accountId: string): Promise<void> {
		await this.removeAccount(accountId);
	}

	/**
	 * Store the timestamp when app went to background
	 */
	async storeBackgroundTimestamp(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const key = getAccountKey(resolvedAccountId, "background_timestamp");
		await this.setItem(key, Date.now().toString());
	}

	/**
	 * Get the timestamp when app went to background
	 */
	async getBackgroundTimestamp(accountId?: string): Promise<number | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "background_timestamp");
		const timestamp = await this.getItem(key);
		return timestamp ? Number.parseInt(timestamp, 10) : null;
	}

	/**
	 * Clear the background timestamp
	 */
	async clearBackgroundTimestamp(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const key = getAccountKey(resolvedAccountId, "background_timestamp");
		await this.deleteItem(key);
	}

	/**
	 * Check if app should require re-authentication after returning from background
	 */
	async shouldRequireAuthAfterBackground(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		const backgroundTimestamp =
			await this.getBackgroundTimestamp(resolvedAccountId);
		if (!backgroundTimestamp) return false;

		const autoLockTimeout =
			await this.getAutoLockTimeoutOrDefault(resolvedAccountId);

		// If auto-lock is set to "Never" (-1), don't require re-auth
		if (autoLockTimeout === -1) return false;

		const timeSinceBackground = Date.now() - backgroundTimestamp;
		return timeSinceBackground > autoLockTimeout;
	}

	/**
	 * Check if biometric authentication is required (public wrapper)
	 */
	async isBiometricAuthRequiredPublic(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;
		return this.isBiometricAuthRequiredInternal(resolvedAccountId);
	}

	/**
	 * Decrypt stored master unlock key (interface method)
	 */
	async decryptStoredMasterUnlockKey(
		accountId?: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;
		return this.decryptStoredMasterUnlockKeyInternal(
			resolvedAccountId,
			skipBiometric,
		);
	}

	/**
	 * @deprecated Use decryptStoredMasterUnlockKey instead
	 */
	async decryptStoredMasterUnlockKeyPublic(
		accountId?: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		return this.decryptStoredMasterUnlockKey(accountId, skipBiometric);
	}

	/**
	 * Update the last master password entry timestamp (for 30-day re-entry requirement)
	 */
	async updateLastMasterPasswordEntry(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const sessionData = await this.getStoredSessionData(resolvedAccountId);
		if (!sessionData) return;

		sessionData.lastMasterPasswordEntry = Date.now();

		const key = getAccountKey(resolvedAccountId, "session_data");
		await this.setItem(key, JSON.stringify(sessionData));
	}

	/**
	 * Enhanced biometric authentication with detailed error handling
	 */
	async authenticateWithBiometricEnhanced(
		reason = "Unlock Bittery",
		accountId?: string,
	): Promise<BiometricAuthResult> {
		try {
			const resolvedAccountId = await this.resolveAccountId(accountId);
			if (!resolvedAccountId) {
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
			const isEnabled = await this.isBiometricEnabled(resolvedAccountId);
			if (!isEnabled) {
				return {
					success: false,
					error: "not_enabled",
					message: "Biometric authentication is not enabled for this account",
				};
			}

			// Check if master password re-entry is required
			if (
				await this.isMasterPasswordReentryRequiredInternal(resolvedAccountId)
			) {
				return {
					success: false,
					error: "master_password_required",
					message:
						"For your security, please enter your master password. This is required periodically.",
				};
			}

			// Check if session is valid
			if (!(await this.isSessionValid(resolvedAccountId))) {
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
				const key = getAccountKey(resolvedAccountId, "last_biometric_auth");
				await this.setItem(key, Date.now().toString());

				// Clear background timestamp on successful auth
				await this.clearBackgroundTimestamp(resolvedAccountId);

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
