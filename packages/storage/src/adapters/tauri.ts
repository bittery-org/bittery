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
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemCacheMetadata,
	KdfParams,
} from "@bittery/types";
import type { Store } from "@tauri-apps/plugin-store";
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
	MASTER_PASSWORD_REENTRY_PERIOD_MS,
	type StoredSessionData,
	type TravelModeConfig,
	type VaultKeyData,
} from "../types";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_KEYCHAIN_KEY = "device_key"; // Stored in OS keychain
const DEVICE_KEY_STORAGE_LEGACY = "bittery_device_key"; // Legacy: Tauri Store (for migration)
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";
const AUTO_LOCK_TIMEOUT_KEY = "bittery_auto_lock_timeout";
const MASTER_PASSWORD_REENTRY_PERIOD_KEY =
	"bittery_master_password_reentry_period_ms";
const LEGACY_SERVER_URL_STORAGE = "bittery_server_url"; // Legacy, now account-scoped

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

// Cache for active account to avoid repeated IPC calls
let cachedActiveAccount: ActiveAccount | undefined;

// Device key cache — global, not per-account (survives lock/unlock, cleared only on full data wipe)
let cachedDeviceKey: Uint8Array | null = null;

// In-flight promise dedup to prevent concurrent keychain reads for the same data
let deviceKeyPromise: Promise<Uint8Array> | null = null;
const authTokenPromises: Map<string, Promise<string | null>> = new Map();

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
	readonly supportsItemCache = true;

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

		// Migrate legacy email-keyed storage to accountId keys
		if (this.store) {
			const store = this.store;
			await migrateEmailKeysToAccountIds({
				store: {
					get: <T>(key: string) => store.get<T>(key),
					set: (key, value) => store.set(key, value),
					delete: async (key) => {
						await store.delete(key);
					},
					save: () => store.save(),
				},
				activeAccountKey: ACTIVE_ACCOUNT_KEY,
				accountsListKey: ACCOUNTS_LIST_KEY,
				getAccountsList: async () =>
					(await this.getAccountsListInternal()).accounts,
				saveAccountsList: async (accounts) => {
					const s = await this.getStore();
					await s.set(ACCOUNTS_LIST_KEY, JSON.stringify({ accounts }));
				},
				copyKeychainKey: async (legacyEmail, accountId, suffix) => {
					if (!this.invoke) return;
					const legacyKey = getLegacyAccountKey(legacyEmail, suffix);
					const newKey = getAccountKey(accountId, suffix);
					const value = await this.invoke("keychain_get", {
						key: legacyKey,
					});
					if (value) {
						await this.invoke("keychain_set", { key: newKey, value });
						const copied = await this.invoke("keychain_get", { key: newKey });
						if (copied !== value) {
							throw new Error(
								`Failed to verify keychain migration for ${newKey}`,
							);
						}
					}
				},
				deleteLegacyKeychainKey: async (legacyEmail, suffix) => {
					if (!this.invoke) return;
					await this.invoke("keychain_delete", {
						key: getLegacyAccountKey(legacyEmail, suffix),
					});
				},
			});

			// Pre-load active account into cache to avoid repeated IPC calls
			const stored = await store.get<string>(ACTIVE_ACCOUNT_KEY);
			cachedActiveAccount = parseStoredActiveAccount(stored);
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

	private getBearerTokenKey(accountId: string): string {
		return getAccountKey(accountId, "jwt_token");
	}

	private async getBearerTokenFromKeychain(
		accountId: string,
	): Promise<string | null> {
		if (!this.invoke) {
			throw new Error("Keychain is not available");
		}

		const keychainValue = await this.invoke("keychain_get", {
			key: this.getBearerTokenKey(accountId),
		});
		return keychainValue ?? null;
	}

	private async setBearerTokenInKeychain(
		accountId: string,
		token: string,
	): Promise<void> {
		if (!this.invoke) {
			throw new Error("Keychain is not available");
		}

		await this.invoke("keychain_set", {
			key: this.getBearerTokenKey(accountId),
			value: token,
		});
	}

	private async deleteBearerTokenFromKeychain(
		accountId: string,
	): Promise<void> {
		if (!this.invoke) {
			return;
		}

		await this.invoke("keychain_delete", {
			key: this.getBearerTokenKey(accountId),
		});
	}

	private async resolveAccountId(accountId?: string): Promise<string | null> {
		if (accountId) return accountId;

		const account = await this.getActiveAccount();
		if (!account || account.type === "all") return null;
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
		// Return from in-memory cache if available (survives lock/unlock)
		if (cachedDeviceKey) {
			return cachedDeviceKey;
		}

		// Deduplicate concurrent calls — if a read is already in-flight, await it
		if (deviceKeyPromise) {
			return deviceKeyPromise;
		}

		deviceKeyPromise = this.getDeviceKeyInternal();
		try {
			const result = await deviceKeyPromise;
			cachedDeviceKey = result;
			return result;
		} finally {
			deviceKeyPromise = null;
		}
	}

	private async getDeviceKeyInternal(): Promise<Uint8Array> {
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

	async getMasterUnlockKey(accountId?: string): Promise<Uint8Array | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.masterUnlockKey) {
			return cache.masterUnlockKey;
		}

		// Try to restore from persistent storage if session is still valid
		if (await this.isSessionValid(resolvedAccountId)) {
			const restored = await this.decryptStoredMasterUnlockKey(
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

		// Update lock state marker for Rust lock-status endpoint
		await this.updateLockStateMarker();

		// Broadcast unlock event to extension (for SSE)
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			const unlockedAccounts = await this.getUnlockedAccounts();
			await invoke("broadcast_unlock_event", { accounts: unlockedAccounts });
			console.log("[storage-tauri] Broadcast unlock event to extension");
		} catch (error) {
			console.error("[storage-tauri] Failed to broadcast unlock event:", error);
		}
	}

	async clearMasterUnlockKey(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = this.getAccountCache(resolvedAccountId);
		cache.masterUnlockKey = null;

		// Update lock state marker for Rust lock-status endpoint
		await this.updateLockStateMarker();
	}

	async storeSessionData(
		masterUnlockKey: Uint8Array,
		accountId: string,
		email: string,
		userId: string,
		expiresAt?: string | Date | number,
		sessionId?: string,
	): Promise<void> {
		const store = await this.getStore();
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
			lastMasterPasswordEntry: now, // Track when user last entered master password
		};

		const key = getAccountKey(accountId, "session_data");
		await store.set(key, JSON.stringify(sessionData));
		await store.save();
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
			console.log("[storage-tauri] Session restored from memory cache");
			return true;
		}

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey = await this.decryptStoredMasterUnlockKey(
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "secret_key");
		await store.set(key, secretKey);
		await store.save();
	}

	async getStoredSecretKey(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "secret_key");
		return (await store.get<string>(key)) ?? null;
	}

	async storeAuthToken(token: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedAccountId);
		cache.authToken = token;

		await this.setBearerTokenInKeychain(resolvedAccountId, token);
	}

	async getAuthToken(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.authToken) {
			return cache.authToken;
		}

		// Deduplicate concurrent reads for the same account
		const existing = authTokenPromises.get(resolvedAccountId);
		if (existing) {
			return existing;
		}

		const promise = this.getAuthTokenInternal(resolvedAccountId);
		authTokenPromises.set(resolvedAccountId, promise);
		try {
			return await promise;
		} finally {
			authTokenPromises.delete(resolvedAccountId);
		}
	}

	private async getAuthTokenInternal(
		resolvedAccountId: string,
	): Promise<string | null> {
		const cache = this.getAccountCache(resolvedAccountId);

		let token: string | null = null;
		try {
			token = await this.getBearerTokenFromKeychain(resolvedAccountId);
		} catch (error) {
			console.error(
				"[storage-tauri] Failed to read bearer token from keychain:",
				error,
			);
			return null;
		}

		if (!token) {
			const store = await this.getStore();
			const legacyKey = this.getBearerTokenKey(resolvedAccountId);
			const legacyToken = await store.get<string>(legacyKey);

			if (legacyToken) {
				try {
					await this.setBearerTokenInKeychain(resolvedAccountId, legacyToken);
					await store.delete(legacyKey);
					await store.save();
					token = legacyToken;
				} catch (error) {
					console.error(
						"[storage-tauri] Failed migrating bearer token to keychain:",
						error,
					);
					return null;
				}
			}
		}

		if (token) {
			cache.authToken = token;
		}

		return token ?? null;
	}

	async storeVaultKeys(
		vaultKeys: VaultKeyData[],
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		console.log(
			"[storage-tauri] Storing vault keys:",
			vaultKeys.length,
			"keys",
		);

		const cache = this.getAccountCache(resolvedAccountId);
		cache.vaultKeys = vaultKeys;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "vault_keys");
		await store.set(key, JSON.stringify(vaultKeys));
		await store.save();
	}

	async getVaultKeys(accountId?: string): Promise<VaultKeyData[] | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.vaultKeys) {
			return cache.vaultKeys;
		}

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "vault_keys");
		const stored = await store.get<string>(key);
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "encrypted_private_key");
		await store.set(key, encryptedPrivateKey);
		await store.save();
	}

	async getEncryptedPrivateKey(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "encrypted_private_key");
		return (await store.get<string>(key)) ?? null;
	}

	async storePinnedKdfParams(
		params: KdfParams,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "pinned_kdf_params");
		await store.set(key, JSON.stringify(params));
		await store.save();
	}

	async getPinnedKdfParams(accountId?: string): Promise<KdfParams | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "pinned_kdf_params");
		const stored = await store.get<string>(key);
		if (!stored) {
			return null;
		}
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

		const store = await this.getStore();
		const key = getAccountKey(accountId, "session_data");
		const next: StoredSessionData = {
			...existing,
			sessionId: metadata.sessionId ?? existing.sessionId,
			expiresAt: resolveStoredSessionExpiryTimestamp(
				metadata.expiresAt,
				existing.createdAt,
			),
		};
		await store.set(key, JSON.stringify(next));
		await store.save();
	}

	// ============================================================================
	// Multi-Account
	// ============================================================================

	async getActiveAccount(): Promise<ActiveAccount> {
		// Return cached value if available to avoid repeated IPC calls
		if (cachedActiveAccount !== undefined) {
			return cachedActiveAccount;
		}

		const store = await this.getStore();
		const stored = await store.get<string>(ACTIVE_ACCOUNT_KEY);
		const account = parseStoredActiveAccount(stored);

		cachedActiveAccount = account;
		return account;
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const account = await this.getActiveAccount();
		if (!account || account.type === "all") return null;

		const sessionData = await this.getStoredSessionData(account.accountId);
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(account: ActiveAccount): Promise<void> {
		const store = await this.getStore();
		const normalizedValue = serializeActiveAccount(account);

		if (normalizedValue) {
			await store.set(ACTIVE_ACCOUNT_KEY, normalizedValue);
		} else {
			await store.delete(ACTIVE_ACCOUNT_KEY);
		}
		await store.save();

		// Update the cache
		cachedActiveAccount = account;

		// Update lastActiveAt if single account
		if (account?.type === "single") {
			const accountsList = await this.getAccountsListInternal();
			const accountMeta = findAccountById(
				accountsList.accounts,
				account.accountId,
			);
			if (accountMeta) {
				accountMeta.lastActiveAt = Date.now();
				await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
				await store.save();
			}
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

		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		await store.save();
	}

	async removeAccount(accountId: string): Promise<void> {
		const store = await this.getStore();

		// Clear the active account cache if removing the active account
		const currentAccount = await this.getActiveAccount();
		if (
			currentAccount?.type === "single" &&
			currentAccount.accountId === accountId
		) {
			cachedActiveAccount = null;
		}

		// Delete all namespaced keys for this account. Iterating the shared
		// ACCOUNT_STORAGE_SUFFIXES keeps removal complete as suffixes are added
		// (previously auto_lock_timeout/background_timestamp were leaked here).
		// jwt_token lives in the OS keychain on Tauri, not the store, so its store
		// delete is a harmless no-op and the keychain entry is cleared below.
		for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
			await store.delete(getAccountKey(accountId, suffix));
		}
		await store.save();
		await this.deleteBearerTokenFromKeychain(accountId);

		this.clearAccountCache(accountId);

		// Remove from accounts list
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.accountId !== accountId,
		);
		await store.set(ACCOUNTS_LIST_KEY, JSON.stringify(accountsList));
		await store.save();
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(
		timeoutMs: number,
		_accountId?: string,
	): Promise<void> {
		const store = await this.getStore();
		await store.set(AUTO_LOCK_TIMEOUT_KEY, timeoutMs);
		await this.clearLegacyAutoLockTimeoutKeys();
		await store.save();
	}

	async getAutoLockTimeout(accountId?: string): Promise<number | null> {
		const store = await this.getStore();
		const globalTimeout = await store.get<number>(AUTO_LOCK_TIMEOUT_KEY);
		if (typeof globalTimeout === "number") {
			return globalTimeout;
		}

		// Legacy migration: account-scoped timeout -> app-scoped timeout.
		const legacyTimeout = await this.getLegacyAutoLockTimeout(accountId);
		if (legacyTimeout === null) {
			return null;
		}

		await store.set(AUTO_LOCK_TIMEOUT_KEY, legacyTimeout);
		await this.clearLegacyAutoLockTimeoutKeys();
		await store.save();
		return legacyTimeout;
	}

	async getAutoLockTimeoutOrDefault(accountId?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(accountId);
		// Default: 10 minutes
		return timeout ?? 10 * 60 * 1000;
	}

	async storeMasterPasswordReentryPeriodMs(periodMs: number): Promise<void> {
		const store = await this.getStore();
		await store.set(MASTER_PASSWORD_REENTRY_PERIOD_KEY, periodMs);
		await store.save();
	}

	async getMasterPasswordReentryPeriodMs(): Promise<number> {
		const store = await this.getStore();
		const stored = await store.get<number>(MASTER_PASSWORD_REENTRY_PERIOD_KEY);
		if (typeof stored === "number") {
			return stored;
		}
		return MASTER_PASSWORD_REENTRY_PERIOD_MS;
	}

	private async getLegacyAutoLockTimeout(
		accountId?: string,
	): Promise<number | null> {
		const store = await this.getStore();
		const candidateEmails = new Set<string>();
		const candidateAccountIds = new Set<string>();

		if (accountId) {
			candidateAccountIds.add(accountId);
			const accountsList = await this.getAccountsListInternal();
			const account = findAccountById(accountsList.accounts, accountId);
			if (account) {
				candidateEmails.add(account.email.toLowerCase());
			}
		}

		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (resolvedAccountId) {
			candidateAccountIds.add(resolvedAccountId);
			if (resolvedAccountId !== accountId) {
				const accountsList = await this.getAccountsListInternal();
				const account = findAccountById(
					accountsList.accounts,
					resolvedAccountId,
				);
				if (account) {
					candidateEmails.add(account.email.toLowerCase());
				}
			}
		}

		if (candidateEmails.size === 0) {
			const accountsList = await this.getAccountsListInternal();
			for (const account of accountsList.accounts) {
				candidateAccountIds.add(account.accountId);
				candidateEmails.add(account.email.toLowerCase());
			}
		}

		// The shared account-id migration copies the legacy per-email timeout into
		// an accountId-scoped key and then deletes the legacy email key. Tauri
		// treats auto_lock_timeout as a GLOBAL setting and never persists to the
		// accountId key itself, so that migrated value would otherwise be orphaned
		// and the user's customized timeout would silently reset to the default.
		// Read it back here so it can be promoted to the global key (M1).
		for (const candidateAccountId of candidateAccountIds) {
			const migratedKey = getAccountKey(
				candidateAccountId,
				"auto_lock_timeout",
			);
			const timeout = await store.get<number>(migratedKey);
			if (typeof timeout === "number") {
				return timeout;
			}
		}

		for (const candidateEmail of candidateEmails) {
			const legacyKey = getLegacyAccountKey(
				candidateEmail,
				"auto_lock_timeout",
			);
			const timeout = await store.get<number>(legacyKey);
			if (typeof timeout === "number") {
				return timeout;
			}
		}

		return null;
	}

	private async clearLegacyAutoLockTimeoutKeys(): Promise<void> {
		const store = await this.getStore();
		const accountsList = await this.getAccountsListInternal();

		for (const account of accountsList.accounts) {
			await store.delete(
				getLegacyAccountKey(account.email.toLowerCase(), "auto_lock_timeout"),
			);
			// Remove the orphaned accountId-scoped key populated by the account-id
			// migration once its value has been promoted to the global key.
			await store.delete(getAccountKey(account.accountId, "auto_lock_timeout"));
		}
	}

	private formatMasterPasswordReentryPeriod(periodMs: number): string {
		const days = Math.round(periodMs / (24 * 60 * 60 * 1000));
		return `${days} day${days === 1 ? "" : "s"}`;
	}

	async storeServerUrl(serverUrl: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "server_url");
		await store.set(key, serverUrl);
		await store.save();
	}

	async getServerUrl(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "server_url");
		return (await store.get<string>(key)) ?? null;
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

		// Clear item cache (items require MUK for vault key decryption)
		await this.clearItemCache(resolvedAccountId);

		// Clear last biometric auth timestamp so biometric is required on next unlock
		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "last_biometric_auth");
		await store.delete(key);
		await store.save();
	}

	async clearAllStoredData(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (resolvedAccountId) {
			await this.removeAccount(resolvedAccountId);
		}

		// If no accounts remain, clear the device key cache
		const remaining = await this.getAccountsList();
		if (remaining.length === 0) {
			cachedDeviceKey = null;
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

	async getBiometricAvailabilityDetails(): Promise<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}> {
		if (!this.biometryModule) {
			return { hasHardware: false, isEnrolled: false };
		}
		try {
			const status = await this.biometryModule.checkStatus();
			return {
				hasHardware: status.isAvailable,
				isEnrolled: status.isAvailable, // Tauri plugin combines these
			};
		} catch {
			return { hasHardware: false, isEnrolled: false };
		}
	}

	async getBiometricType(): Promise<string | null> {
		if (!this.biometryModule) return null;
		try {
			const status = await this.biometryModule.checkStatus();
			if (!status.isAvailable) return null;
			// Tauri biometry plugin returns biometry type in status
			return status.biometryType ? String(status.biometryType) : "Biometric";
		} catch {
			return null;
		}
	}

	async isBiometricEnabled(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "biometric_enabled");
		const enabled = await store.get<boolean>(key);
		return enabled === true;
	}

	async enableBiometric(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "biometric_enabled");
		await store.set(key, true);
		await store.save();
	}

	async disableBiometric(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "biometric_enabled");
		await store.set(key, false);
		await store.save();
	}

	async authenticateWithBiometric(
		reason = "Unlock Bittery",
		accountId?: string,
	): Promise<boolean> {
		if (!this.biometryModule) return false;

		try {
			const resolvedAccountId = await this.resolveAccountId(accountId);
			if (!resolvedAccountId) return false;

			await this.biometryModule.authenticate(reason);

			// Update last biometric auth timestamp
			const store = await this.getStore();
			const key = getAccountKey(resolvedAccountId, "last_biometric_auth");
			await store.set(key, Date.now());
			await store.save();

			return true;
		} catch (error) {
			console.error("[storage-tauri] Biometric authentication failed:", error);
			return false;
		}
	}

	async canBiometricUnlock(accountId?: string): Promise<boolean> {
		const available = await this.isBiometricAvailable();
		const enabled = await this.isBiometricEnabled(accountId);
		const sessionValid = await this.isSessionValid(accountId);
		return available && enabled && sessionValid;
	}

	async authenticateWithBiometricEnhanced(
		reason = "Unlock Bittery",
		accountId?: string,
	): Promise<{
		success: boolean;
		error?:
			| "not_available"
			| "not_enrolled"
			| "not_enabled"
			| "authentication_failed"
			| "user_cancelled"
			| "lockout"
			| "session_expired"
			| "master_password_required"
			| "unknown";
		message?: string;
	}> {
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
			if (!this.biometryModule) {
				return {
					success: false,
					error: "not_available",
					message: "Biometric authentication not available",
				};
			}

			const status = await this.biometryModule.checkStatus();
			if (!status.isAvailable) {
				return {
					success: false,
					error: "not_available",
					message: "This device does not support biometric authentication",
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

			// Check if session is valid
			if (!(await this.isSessionValid(resolvedAccountId))) {
				return {
					success: false,
					error: "session_expired",
					message: "Your session has expired. Please log in again",
				};
			}

			// Check if master password re-entry is required by configured policy
			if (await this.isMasterPasswordReentryRequired(resolvedAccountId)) {
				const reentryPeriodMs = await this.getMasterPasswordReentryPeriodMs();
				return {
					success: false,
					error: "master_password_required",
					message: `For security, please enter your master password. This is required every ${this.formatMasterPasswordReentryPeriod(reentryPeriodMs)}.`,
				};
			}

			await this.biometryModule.authenticate(reason);

			// Update last biometric auth timestamp
			const store = await this.getStore();
			const key = getAccountKey(resolvedAccountId, "last_biometric_auth");
			await store.set(key, Date.now());
			await store.save();

			return { success: true };
		} catch (error) {
			console.error("[storage-tauri] Biometric authentication error:", error);

			// Try to determine error type from error message
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			if (errorMessage.includes("cancel") || errorMessage.includes("Cancel")) {
				return {
					success: false,
					error: "user_cancelled",
					message: "Authentication was cancelled",
				};
			}

			return {
				success: false,
				error: "authentication_failed",
				message: "Biometric authentication failed. Please try again",
			};
		}
	}

	// ============================================================================
	// Master Password Re-entry (shared security feature for biometric platforms)
	// ============================================================================

	async isMasterPasswordReentryRequired(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		const sessionData = await this.getStoredSessionData(resolvedAccountId);
		if (!sessionData) return false;

		// If biometric is not enabled, no re-entry requirement
		if (!sessionData.biometricEnabled) return false;

		// Check if lastMasterPasswordEntry exists, fall back to createdAt
		const lastEntry =
			sessionData.lastMasterPasswordEntry ?? sessionData.createdAt;
		const timeSinceLastEntry = Date.now() - lastEntry;
		const reentryPeriodMs = await this.getMasterPasswordReentryPeriodMs();
		if (reentryPeriodMs < 0) return false;
		return timeSinceLastEntry > reentryPeriodMs;
	}

	async updateLastMasterPasswordEntry(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const sessionData = await this.getStoredSessionData(resolvedAccountId);
		if (!sessionData) return;

		// Update the timestamp
		sessionData.lastMasterPasswordEntry = Date.now();

		// Persist the updated session data
		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "session_data");
		await store.set(key, JSON.stringify(sessionData));
		await store.save();
	}

	/**
	 * Public wrapper for decrypting stored MUK
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

	private async decryptStoredMasterUnlockKeyInternal(
		accountId: string,
		skipBiometric = false,
	): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData(accountId);
		if (!sessionData) {
			console.log("[storage-tauri] No session data found for:", accountId);
			return null;
		}

		// Check if biometric authentication is required
		if (!skipBiometric && sessionData.biometricEnabled) {
			const authRequired = await this.isBiometricAuthRequired(accountId);
			if (authRequired) {
				const authenticated = await this.authenticateWithBiometric(
					"Unlock your vault",
					accountId,
				);
				if (!authenticated) {
					console.log(
						"[storage-tauri] Biometric authentication failed for:",
						accountId,
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

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async isBiometricAuthRequired(accountId: string): Promise<boolean> {
		const sessionData = await this.getStoredSessionData(accountId);
		if (!sessionData || !sessionData.biometricEnabled) {
			return false;
		}

		const store = await this.getStore();
		const key = getAccountKey(accountId, "last_biometric_auth");
		const lastAuth = await store.get<number>(key);

		if (!lastAuth) {
			return true;
		}

		const timeSinceLastAuth = Date.now() - lastAuth;
		return timeSinceLastAuth > BIOMETRIC_GRACE_PERIOD_MS;
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "cached_items");
		await store.set(key, JSON.stringify(items));
		await store.save();
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "cached_items");
		const stored = await store.get<string>(key);
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "cached_vaults");
		await store.set(key, JSON.stringify(vaults));
		await store.save();
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "cached_vaults");
		const stored = await store.get<string>(key);
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "item_cache_meta");
		const stored = await store.get<string>(key);
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

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "item_cache_meta");
		await store.set(key, JSON.stringify(metadata));
		await store.save();
	}

	async clearItemCache(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = this.getAccountCache(resolvedAccountId);
		cache.cachedItems = null;
		cache.cachedVaults = null;

		const store = await this.getStore();
		await store.delete(getAccountKey(resolvedAccountId, "cached_items"));
		await store.delete(getAccountKey(resolvedAccountId, "cached_vaults"));
		await store.delete(getAccountKey(resolvedAccountId, "item_cache_meta"));
		await store.save();
	}

	async storeTravelModeCache(
		config: TravelModeConfig,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const store = await this.getStore();
		await store.set(
			getAccountKey(resolvedAccountId, "travel_mode_cache"),
			JSON.stringify(config),
		);
		await store.save();
	}

	async getTravelModeCache(
		accountId?: string,
	): Promise<TravelModeConfig | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const store = await this.getStore();
		const stored = await store.get<string>(
			getAccountKey(resolvedAccountId, "travel_mode_cache"),
		);
		if (!stored) return null;
		try {
			return JSON.parse(stored) as TravelModeConfig;
		} catch {
			return null;
		}
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
	async clearServerUrl(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const store = await this.getStore();
		const key = getAccountKey(resolvedAccountId, "server_url");
		await store.delete(key);
		await store.save();
	}

	/**
	 * Clear app-wide auto-lock timeout preference
	 */
	async clearAutoLockTimeout(_accountId?: string): Promise<void> {
		const store = await this.getStore();
		await store.delete(AUTO_LOCK_TIMEOUT_KEY);
		await this.clearLegacyAutoLockTimeoutKeys();
		await store.save();
	}

	/**
	 * Get stored session data (public method for desktop)
	 */
	async getStoredSessionData(
		accountId?: string,
	): Promise<StoredSessionData | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		try {
			const store = await this.getStore();
			const key = getAccountKey(resolvedAccountId, "session_data");
			const stored = await store.get<string>(key);

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

			const masterUnlockKey = await this.decryptStoredMasterUnlockKey(
				resolvedAccountId,
				false,
			);
			if (!masterUnlockKey) {
				return false;
			}

			await this.setMasterUnlockKey(masterUnlockKey, resolvedAccountId);
			return true;
		} catch (error) {
			console.error("[storage-tauri] Biometric unlock failed:", error);
			return false;
		}
	}

	/**
	 * Update the lock state marker in store for Rust lock-status endpoint
	 * This marker reflects which accounts have MUKs in memory (true source of truth)
	 */
	private async updateLockStateMarker(): Promise<void> {
		const unlockedAccountIds = await this.getUnlockedAccounts();
		const store = await this.getStore();
		await store.set(
			"bittery_unlocked_accounts",
			JSON.stringify(unlockedAccountIds),
		);
		await store.save();
	}

	/**
	 * Lock all accounts (clear all in-memory caches and biometric auth timestamps)
	 */
	async lockAllAccounts(): Promise<void> {
		accountCaches.clear();

		// Clear last biometric auth timestamp for all accounts
		// This forces fresh biometric authentication on next unlock
		// Note: JWT tokens are NOT deleted - they're for server auth, not lock state
		const store = await this.getStore();
		const accountsList = await this.getAccountsList();
		for (const account of accountsList) {
			const biometricKey = getAccountKey(
				account.accountId,
				"last_biometric_auth",
			);
			await store.delete(biometricKey);
		}

		// Update lock state marker (for Rust lock-status endpoint)
		await store.set("bittery_unlocked_accounts", JSON.stringify([]));
		await store.save();
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
			// No account supports biometric
			for (const account of accountsList) {
				failed.push({
					accountId: account.accountId,
					error: "Biometric authentication not available",
				});
			}
			return { unlocked, failed };
		}

		// FORCE biometric authentication (ignore grace period)
		// This ensures we ALWAYS show the prompt when explicitly unlocking
		const authenticated = await this.authenticateWithBiometric(
			"Unlock all accounts",
			firstAccountId,
		);

		if (!authenticated) {
			// Biometric authentication failed or was cancelled
			for (const account of accountsList) {
				failed.push({
					accountId: account.accountId,
					error: "Biometric authentication failed or cancelled",
				});
			}
			return { unlocked, failed };
		}

		// Now unlock ALL accounts WITHOUT additional biometric prompts
		// Since we just authenticated, all accounts within the grace period can be unlocked
		for (const account of accountsList) {
			try {
				// Decrypt MUK using device key (biometric was already authenticated)
				const masterUnlockKey = await this.decryptStoredMasterUnlockKey(
					account.accountId,
					true, // skipBiometric = true (we already authenticated above)
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
	 * Clear stored session data from disk
	 */
	async clearStoredSession(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const store = await this.getStore();
		await store.delete(getAccountKey(resolvedAccountId, "session_data"));
		await store.delete(getAccountKey(resolvedAccountId, "last_biometric_auth"));
		await store.save();
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
	 * Get time until session expires (in milliseconds)
	 */
	async getTimeUntilExpiry(accountId?: string): Promise<number | null> {
		const sessionData = await this.getStoredSessionData(accountId);
		if (!sessionData) return null;

		const now = Date.now();
		const timeLeft = sessionData.expiresAt - now;
		return timeLeft > 0 ? timeLeft : 0;
	}

	/**
	 * Clear all data for a specific account
	 */
	async clearAccountData(accountId: string): Promise<void> {
		await this.removeAccount(accountId);
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
		const store = await this.getStore();
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.accountId !== accountId,
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
): TauriStorageAdapter {
	return new TauriStorageAdapter(crypto);
}
