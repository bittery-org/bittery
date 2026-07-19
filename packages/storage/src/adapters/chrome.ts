/**
 * Chrome Extension Storage Adapter
 * Uses chrome.storage APIs for credentials/session and IndexedDB for item cache
 */
/// <reference types="chrome" />
/// <reference lib="dom" />

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemCacheMetadata,
	KdfProfile,
} from "@bittery/types";
import {
	findAccountById,
	findAccountByServerUser,
	generateAccountId,
} from "../account-id";
import {
	ACCOUNT_ID_MIGRATION_FLAG,
	ACCOUNT_STORAGE_SUFFIXES,
	getAccountKey,
	getLegacyAccountKey,
} from "../account-keys";
import type { IStorageAdapter } from "../adapter";
import type { CryptoProvider } from "../crypto-provider";
import { parseStoredKdfProfile } from "../kdf-profile";
import {
	migrateEmailKeysToAccountIds,
	parseStoredActiveAccount,
	serializeActiveAccount,
} from "../migrate-to-account-ids";
import { resolveStoredSessionExpiryTimestamp } from "../session";
import type {
	AccountMetadata,
	ActiveAccount,
	BiometricAuthResult,
	StoredSessionData,
	TravelModeConfig,
	VaultKeyData,
} from "../types";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_STORAGE = "bittery_device_key";
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";
const ITEM_CACHE_DB_NAME = "bittery_item_cache_extension";
const ITEM_CACHE_DB_VERSION = 2;
const ITEM_CACHE_ITEMS_STORE = "items";
const ITEM_CACHE_VAULTS_STORE = "vaults";
const ITEM_CACHE_METADATA_STORE = "metadata";
const ITEM_CACHE_ACCOUNT_INDEX = "by_account";
const ITEM_CACHE_META_KEY = "item_cache_meta";
const CACHED_ITEMS_SUFFIX = "cached_items";
const CACHED_VAULTS_SUFFIX = "cached_vaults";
const ITEM_CACHE_META_SUFFIX = "item_cache_meta";
const TRAVEL_MODE_CACHE_SUFFIX = "travel_mode_cache";

interface AccountsList {
	accounts: AccountMetadata[];
}

interface ItemCacheRecord<T> {
	id: string;
	accountKey: string;
	value: T;
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

// Cache for active account to avoid repeated storage reads
let cachedActiveAccount: ActiveAccount | undefined;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}

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
 * Chrome Extension Storage Adapter Implementation
 */
export class ChromeStorageAdapter implements IStorageAdapter {
	readonly platform = "extension" as const;
	readonly supportsMultiAccount = true;
	readonly supportsBiometric = false;
	readonly supportsItemCache = true;
	private cacheDbPromise: Promise<IDBDatabase> | null = null;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		// Capture whether the account-id migration has already run before we
		// invoke it below (the migration sets the flag on completion). The
		// legacy session-key migration is a one-time step and must be gated on
		// this so it doesn't re-scan session storage on every service-worker
		// start.
		const migrationFlagResult = await chrome.storage.local.get(
			ACCOUNT_ID_MIGRATION_FLAG,
		);
		const accountIdMigrationAlreadyRan =
			migrationFlagResult[ACCOUNT_ID_MIGRATION_FLAG] === true;

		// Migrate legacy email-keyed storage to accountId keys
		await migrateEmailKeysToAccountIds({
			store: {
				get: async <T>(key: string) => {
					const result = await chrome.storage.local.get(key);
					return result[key] as T | undefined;
				},
				set: async (key, value) => {
					await chrome.storage.local.set({ [key]: value });
				},
				delete: async (key) => {
					await chrome.storage.local.remove(key);
				},
			},
			activeAccountKey: ACTIVE_ACCOUNT_KEY,
			accountsListKey: ACCOUNTS_LIST_KEY,
			getAccountsList: async () =>
				(await this.getAccountsListInternal()).accounts,
			saveAccountsList: async (accounts) => {
				await chrome.storage.local.set({
					[ACCOUNTS_LIST_KEY]: JSON.stringify({ accounts }),
				});
			},
		});

		// Migrate legacy session-scoped keys (encrypted_private_key, jwt_token).
		// Only needed once, on the first run that performs the account-id
		// migration; skip the session-storage scan on subsequent starts.
		if (!accountIdMigrationAlreadyRan) {
			const accountsList = await this.getAccountsListInternal();
			for (const account of accountsList.accounts) {
				for (const suffix of ["jwt_token", "encrypted_private_key"] as const) {
					const legacyKey = getLegacyAccountKey(
						account.email.toLowerCase(),
						suffix,
					);
					const newKey = getAccountKey(account.accountId, suffix);
					const result = await chrome.storage.session.get(legacyKey);
					if (result[legacyKey] !== undefined) {
						await chrome.storage.session.set({ [newKey]: result[legacyKey] });
						await chrome.storage.session.remove(legacyKey);
					}
				}
			}
		}

		await this.migrateIndexedDbAccountKeys();

		// Pre-load active account into cache
		const activeResult = await chrome.storage.local.get(ACTIVE_ACCOUNT_KEY);
		cachedActiveAccount = parseStoredActiveAccount(
			activeResult[ACTIVE_ACCOUNT_KEY] as string | undefined,
		);

		// Listen for storage changes to keep cache in sync across contexts
		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== "local") return;

			// Clear active account cache if it changed
			if (ACTIVE_ACCOUNT_KEY in changes) {
				cachedActiveAccount = undefined;
			}
		});
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

	private getCacheRecordId(accountKey: string, entityId: string): string {
		return `${accountKey}:${entityId}`;
	}

	private getMetadataRecordId(accountKey: string): string {
		return this.getCacheRecordId(accountKey, ITEM_CACHE_META_KEY);
	}

	private async getItemCacheDb(): Promise<IDBDatabase | null> {
		if (typeof indexedDB === "undefined") {
			return null;
		}

		if (!this.cacheDbPromise) {
			this.cacheDbPromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(
					ITEM_CACHE_DB_NAME,
					ITEM_CACHE_DB_VERSION,
				);

				request.onupgradeneeded = () => {
					const db = request.result;
					const upgradeTx = request.transaction;
					if (!upgradeTx) return;

					const ensureStore = (storeName: string) => {
						let store: IDBObjectStore;
						if (!db.objectStoreNames.contains(storeName)) {
							store = db.createObjectStore(storeName, { keyPath: "id" });
						} else {
							store = upgradeTx.objectStore(storeName);
						}

						if (!store.indexNames.contains(ITEM_CACHE_ACCOUNT_INDEX)) {
							store.createIndex(ITEM_CACHE_ACCOUNT_INDEX, "accountKey", {
								unique: false,
							});
						}
					};

					ensureStore(ITEM_CACHE_ITEMS_STORE);
					ensureStore(ITEM_CACHE_VAULTS_STORE);
					ensureStore(ITEM_CACHE_METADATA_STORE);
				};

				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}

		return this.cacheDbPromise;
	}

	private async deleteRecordsForAccount(
		store: IDBObjectStore,
		accountKey: string,
	): Promise<void> {
		const index = store.index(ITEM_CACHE_ACCOUNT_INDEX);

		await new Promise<void>((resolve, reject) => {
			const cursorRequest = index.openCursor(IDBKeyRange.only(accountKey));

			cursorRequest.onsuccess = () => {
				const cursor = cursorRequest.result;
				if (!cursor) {
					resolve();
					return;
				}

				const deleteRequest = cursor.delete();
				deleteRequest.onerror = () => reject(deleteRequest.error);
				deleteRequest.onsuccess = () => cursor.continue();
			};

			cursorRequest.onerror = () => reject(cursorRequest.error);
		});
	}

	private async getRecordsForAccount<T>(
		db: IDBDatabase,
		storeName: string,
		accountKey: string,
	): Promise<ItemCacheRecord<T>[]> {
		const tx = db.transaction(storeName, "readonly");
		const store = tx.objectStore(storeName);
		const records = await requestToPromise(
			store.index(ITEM_CACHE_ACCOUNT_INDEX).getAll(accountKey) as IDBRequest<
				ItemCacheRecord<T>[]
			>,
		);
		await waitForTransaction(tx);
		return records ?? [];
	}

	private async clearStoreForAccount(
		db: IDBDatabase,
		storeName: string,
		accountKey: string,
	): Promise<void> {
		const tx = db.transaction(storeName, "readwrite");
		await this.deleteRecordsForAccount(tx.objectStore(storeName), accountKey);
		await waitForTransaction(tx);
	}

	private async migrateIndexedDbAccountKeys(): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const accounts = await this.getAccountsList();
		for (const account of accounts) {
			const legacyAccountKey = account.email.toLowerCase();
			const accountId = account.accountId;
			if (legacyAccountKey === accountId) continue;

			for (const storeName of [
				ITEM_CACHE_ITEMS_STORE,
				ITEM_CACHE_VAULTS_STORE,
				ITEM_CACHE_METADATA_STORE,
			]) {
				const records = await this.getRecordsForAccount<unknown>(
					db,
					storeName,
					legacyAccountKey,
				);
				if (records.length === 0) continue;

				const tx = db.transaction(storeName, "readwrite");
				const store = tx.objectStore(storeName);
				await this.deleteRecordsForAccount(store, legacyAccountKey);

				for (const record of records) {
					const entityId =
						storeName === ITEM_CACHE_METADATA_STORE
							? ITEM_CACHE_META_KEY
							: (record.value as { id: string }).id;
					await requestToPromise(
						store.put({
							id: this.getCacheRecordId(accountId, entityId),
							accountKey: accountId,
							value: record.value,
						}),
					);
				}

				await waitForTransaction(tx);
			}
		}
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
			const restored =
				await this.decryptStoredMasterUnlockKeyInternal(resolvedAccountId);
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
		const deviceKey = await getDeviceKey();
		const now = Date.now();

		// Encrypt Master Unlock Key with device key
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const encryptedMUK = await this.crypto.encrypt(mukBase64, deviceKey);

		const sessionData: StoredSessionData = {
			encryptedMasterUnlockKey: encryptedMUK,
			email: email.toLowerCase(),
			userId,
			sessionId,
			expiresAt: resolveStoredSessionExpiryTimestamp(expiresAt, now),
			createdAt: now,
		};

		const key = getAccountKey(accountId, "session_data");
		await chrome.storage.local.set({
			[key]: JSON.stringify(sessionData),
		});
	}

	async tryRestoreSession(
		_skipBiometric?: boolean,
		accountId?: string,
	): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) {
			console.log("[storage-chrome] tryRestoreSession: No account resolved");
			return false;
		}

		if (!(await this.isSessionValid(resolvedAccountId))) {
			console.log(
				`[storage-chrome] tryRestoreSession: Session not valid for ${resolvedAccountId}`,
			);
			return false;
		}

		// First check if MUK is already in memory cache (e.g., after login)
		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.masterUnlockKey) {
			// Also ensure auth token and vault keys are in cache
			if (!cache.authToken) {
				const authToken = await this.getAuthToken(resolvedAccountId);
				if (authToken) {
					cache.authToken = authToken;
				}
			}
			if (!cache.vaultKeys) {
				const vaultKeys = await this.getVaultKeys(resolvedAccountId);
				if (vaultKeys) {
					cache.vaultKeys = vaultKeys;
				}
			}
			return true;
		}

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey =
			await this.decryptStoredMasterUnlockKeyInternal(resolvedAccountId);
		if (!masterUnlockKey) {
			console.error(
				`[storage-chrome] tryRestoreSession: Failed to decrypt MUK for ${resolvedAccountId}`,
			);
			return false;
		}

		await this.setMasterUnlockKey(masterUnlockKey, resolvedAccountId);

		// Also restore auth token and vault keys into cache
		// Both are required for a fully functional session
		const authToken = await this.getAuthToken(resolvedAccountId);
		if (!authToken) {
			console.error(
				`[storage-chrome] Cannot restore session for ${resolvedAccountId}: auth token not found in storage`,
			);
			return false;
		}
		cache.authToken = authToken;

		const vaultKeys = await this.getVaultKeys(resolvedAccountId);
		if (!vaultKeys || vaultKeys.length === 0) {
			console.error(
				`[storage-chrome] Cannot restore session for ${resolvedAccountId}: vault keys not found in storage`,
			);
			return false;
		}
		cache.vaultKeys = vaultKeys;

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
		await chrome.storage.local.set({ [key]: secretKey });
	}

	async getStoredSecretKey(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "secret_key");
		const result = await chrome.storage.local.get(key);
		return (result[key] as string | undefined) || null;
	}

	async storeAuthToken(token: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedAccountId);
		cache.authToken = token;

		// Persist to local storage (not session) so it survives service worker restarts
		const key = getAccountKey(resolvedAccountId, "jwt_token");
		await chrome.storage.local.set({ [key]: token });
	}

	async getAuthToken(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.authToken) {
			return cache.authToken;
		}

		// Try to restore from local storage
		const key = getAccountKey(resolvedAccountId, "jwt_token");
		const result = await chrome.storage.local.get(key);
		const token = (result[key] as string | undefined) || null;
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

		const cache = this.getAccountCache(resolvedAccountId);
		cache.vaultKeys = vaultKeys;

		const key = getAccountKey(resolvedAccountId, "vault_keys");
		try {
			// Store in local storage (not session) to persist across service worker restarts
			await chrome.storage.local.set({
				[key]: JSON.stringify(vaultKeys),
			});
		} catch (error) {
			console.error("[storage-chrome] Failed to store vault keys:", error);
			throw error;
		}
	}

	async getVaultKeys(accountId?: string): Promise<VaultKeyData[] | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const cache = this.getAccountCache(resolvedAccountId);
		if (cache.vaultKeys) {
			return cache.vaultKeys;
		}

		const key = getAccountKey(resolvedAccountId, "vault_keys");
		const result = await chrome.storage.local.get(key);
		const stored = result[key];

		if (stored) {
			cache.vaultKeys = JSON.parse(stored as string);
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
		await chrome.storage.session.set({
			[key]: encryptedPrivateKey,
		});
	}

	async getEncryptedPrivateKey(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "encrypted_private_key");
		const result = await chrome.storage.session.get(key);
		return (result[key] as string | undefined) || null;
	}

	async storePinnedKdfProfile(
		profile: KdfProfile,
		accountId: string,
	): Promise<void> {
		const key = getAccountKey(accountId, "pinned_kdf_params");
		await chrome.storage.local.set({ [key]: JSON.stringify(profile) });
	}

	async getPinnedKdfProfile(accountId: string): Promise<KdfProfile | null> {
		const key = getAccountKey(accountId, "pinned_kdf_params");
		const result = await chrome.storage.local.get(key);
		const stored = result[key];
		if (!stored) {
			return null;
		}
		return parseStoredKdfProfile(stored);
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
		await chrome.storage.local.set({
			[key]: JSON.stringify(next),
		});
	}

	// ============================================================================
	// Multi-Account
	// ============================================================================

	async getActiveAccount(): Promise<ActiveAccount> {
		// Return cached value if available
		if (cachedActiveAccount !== undefined) {
			return cachedActiveAccount;
		}

		const result = await chrome.storage.local.get(ACTIVE_ACCOUNT_KEY);
		const stored = result[ACTIVE_ACCOUNT_KEY] as string | undefined;

		const account = parseStoredActiveAccount(stored);
		cachedActiveAccount = account;
		return account;
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
			await chrome.storage.local.set({ [ACTIVE_ACCOUNT_KEY]: normalizedValue });
		} else {
			await chrome.storage.local.remove(ACTIVE_ACCOUNT_KEY);
		}

		// Update cached value
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
				await chrome.storage.local.set({
					[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
				});
			}
		}
	}

	async getAccountsList(): Promise<AccountMetadata[]> {
		const accountsList = await this.getAccountsListInternal();
		return accountsList.accounts;
	}

	private async getAccountsListInternal(): Promise<AccountsList> {
		const result = await chrome.storage.local.get(ACCOUNTS_LIST_KEY);

		const stored = result[ACCOUNTS_LIST_KEY];
		if (!stored) {
			return { accounts: [] };
		}
		try {
			return JSON.parse(stored as string) as AccountsList;
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

		await chrome.storage.local.set({
			[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
		});
	}

	async removeAccount(accountId: string): Promise<void> {
		await this.clearItemCache(accountId);

		// Delete every namespaced key for this account. Iterate the shared
		// suffix list so new per-account suffixes are cleaned up automatically
		// instead of silently leaking when someone forgets to update this list.
		const keysToRemove = ACCOUNT_STORAGE_SUFFIXES.map((suffix) =>
			getAccountKey(accountId, suffix),
		);

		await chrome.storage.local.remove(keysToRemove);
		// jwt_token and encrypted_private_key are also held in session storage.
		await chrome.storage.session.remove([
			getAccountKey(accountId, "jwt_token"),
			getAccountKey(accountId, "encrypted_private_key"),
		]);

		this.clearAccountCache(accountId);

		// Remove from accounts list
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.accountId !== accountId,
		);
		await chrome.storage.local.set({
			[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
		});
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(
		timeoutMs: number,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const key = getAccountKey(resolvedAccountId, "auto_lock_timeout");
		await chrome.storage.local.set({ [key]: timeoutMs });
	}

	async getAutoLockTimeout(accountId?: string): Promise<number | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "auto_lock_timeout");
		const result = await chrome.storage.local.get(key);
		const stored = result[key];
		if (stored !== undefined && typeof stored === "number") {
			return stored;
		}
		return null;
	}

	async getAutoLockTimeoutOrDefault(accountId?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(accountId);
		// Default: 10 minutes
		return timeout ?? 10 * 60 * 1000;
	}

	async storeServerUrl(serverUrl: string, accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) throw new Error("No account specified");

		const key = getAccountKey(resolvedAccountId, "server_url");
		await chrome.storage.local.set({ [key]: serverUrl });
	}

	async getServerUrl(accountId?: string): Promise<string | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const key = getAccountKey(resolvedAccountId, "server_url");
		const result = await chrome.storage.local.get(key);
		return (result[key] as string | undefined) || null;
	}

	// ============================================================================
	// Auth State
	// ============================================================================

	async isAuthenticated(_accountId?: string): Promise<boolean> {
		// If accountId is provided, check that specific account
		if (_accountId) {
			const token = await this.getAuthToken(_accountId);
			return token !== null;
		}

		// For multi-account: check if ANY account is authenticated
		const accounts = await this.getAccountsList();
		if (accounts.length === 0) {
			return false;
		}

		// Check if any account has an auth token
		for (const account of accounts) {
			const token = await this.getAuthToken(account.accountId);
			if (token) {
				return true;
			}
		}

		return false;
	}

	async canQuickUnlock(_accountId?: string): Promise<boolean> {
		// If accountId is provided, check that specific account
		if (_accountId) {
			const hasSecretKey = (await this.getStoredSecretKey(_accountId)) !== null;
			const sessionValid = await this.isSessionValid(_accountId);
			return hasSecretKey && sessionValid;
		}

		// For multi-account: check if ANY account can quick unlock
		const accounts = await this.getAccountsList();
		if (accounts.length === 0) {
			return false;
		}

		// Check if any account has secret key + valid session OR biometric enabled
		for (const account of accounts) {
			const hasSecretKey =
				(await this.getStoredSecretKey(account.accountId)) !== null;
			const sessionValid = await this.isSessionValid(account.accountId);
			const hasBiometric = account.biometricEnabled ?? false;

			if ((hasSecretKey && sessionValid) || hasBiometric) {
				return true;
			}
		}

		return false;
	}

	// ============================================================================
	// Clear
	// ============================================================================

	async clearSession(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		this.clearAccountCache(resolvedAccountId);

		// Clear session storage keys
		// Remove JWT and encrypted private key from session storage
		await chrome.storage.session.remove([
			getAccountKey(resolvedAccountId, "jwt_token"),
			getAccountKey(resolvedAccountId, "encrypted_private_key"),
		]);

		// Remove vault keys from local storage
		await chrome.storage.local.remove([
			getAccountKey(resolvedAccountId, "vault_keys"),
		]);

		// Clear item cache
		await this.clearItemCache(resolvedAccountId);
	}

	async clearAllStoredData(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (resolvedAccountId) {
			await this.removeAccount(resolvedAccountId);
		}
	}

	// ============================================================================
	// Extended Session Management (unified interface)
	// ============================================================================

	async getStoredSessionData(
		accountId?: string,
	): Promise<StoredSessionData | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		try {
			const key = getAccountKey(resolvedAccountId, "session_data");
			const result = await chrome.storage.local.get(key);
			const stored = result[key];

			if (!stored) return null;
			const parsed = JSON.parse(stored as string) as StoredSessionData;
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

	async hasStoredSecretKey(accountId?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey(accountId);
		return secretKey != null;
	}

	async lockAllAccounts(): Promise<void> {
		accountCaches.clear();
	}

	async getAccountMetadata(accountId: string): Promise<AccountMetadata | null> {
		const accountsList = await this.getAccountsList();
		return findAccountById(accountsList, accountId) ?? null;
	}

	async getUnlockedAccounts(): Promise<string[]> {
		// If cache is empty (e.g., after service worker restart), try to restore from storage
		const accounts = await this.getAccountsList();

		const unlockedAccountIds: string[] = [];
		for (const account of accounts) {
			// Try to get MUK (will restore from storage if needed)
			const muk = await this.getMasterUnlockKey(account.accountId);

			if (muk) {
				unlockedAccountIds.push(account.accountId);
			}
		}

		return unlockedAccountIds;
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

	async unlockWithBiometric(_accountId?: string): Promise<boolean> {
		return false;
	}

	async authenticateWithBiometricEnhanced(
		_reason?: string,
		_accountId?: string,
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

	async isMasterPasswordReentryRequired(_accountId?: string): Promise<boolean> {
		return false;
	}

	async updateLastMasterPasswordEntry(_accountId?: string): Promise<void> {
		// No-op
	}

	async decryptStoredMasterUnlockKey(
		accountId?: string,
		_skipBiometric?: boolean,
	): Promise<Uint8Array | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;
		return this.decryptStoredMasterUnlockKeyInternal(resolvedAccountId);
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async decryptStoredMasterUnlockKeyInternal(
		accountId: string,
	): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData(accountId);
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

	// ============================================================================
	// Biometric (extension queries desktop app for biometric support)
	// ============================================================================

	/**
	 * Check if biometric unlock is enabled for this account.
	 * For extensions, this checks the stored account metadata which should be
	 * synced with the desktop app's biometric status.
	 */
	async isBiometricEnabled(accountId?: string): Promise<boolean> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return false;

		const accounts = await this.getAccountsList();
		const account = findAccountById(accounts, resolvedAccountId);

		return account?.biometricEnabled ?? false;
	}

	/**
	 * Update the biometric enabled status for an account.
	 * This syncs the local status with the desktop app's biometric setting.
	 */
	async updateBiometricEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		const accountsList = await this.getAccountsListInternal();
		const account = findAccountById(accountsList.accounts, accountId);

		if (account) {
			account.biometricEnabled = enabled;
			await chrome.storage.local.set({
				[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
			});
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

		const db = await this.getItemCacheDb();
		if (!db) {
			const key = getAccountKey(resolvedAccountId, CACHED_ITEMS_SUFFIX);
			await chrome.storage.local.set({ [key]: JSON.stringify(items) });
			return;
		}

		const tx = db.transaction(ITEM_CACHE_ITEMS_STORE, "readwrite");
		const store = tx.objectStore(ITEM_CACHE_ITEMS_STORE);
		await this.deleteRecordsForAccount(store, resolvedAccountId);

		for (const item of items) {
			await requestToPromise(
				store.put({
					id: this.getCacheRecordId(resolvedAccountId, item.id),
					accountKey: resolvedAccountId,
					value: item,
				} satisfies ItemCacheRecord<CachedEncryptedItem>),
			);
		}

		await waitForTransaction(tx);
		await chrome.storage.local.remove(
			getAccountKey(resolvedAccountId, CACHED_ITEMS_SUFFIX),
		);
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

		const db = await this.getItemCacheDb();
		if (db) {
			const records = await this.getRecordsForAccount<CachedEncryptedItem>(
				db,
				ITEM_CACHE_ITEMS_STORE,
				resolvedAccountId,
			);
			if (records.length > 0) {
				cache.cachedItems = records.map((record) => record.value);
				return cache.cachedItems;
			}
		}

		const legacyKey = getAccountKey(resolvedAccountId, CACHED_ITEMS_SUFFIX);
		const result = await chrome.storage.local.get(legacyKey);
		const stored = result[legacyKey];
		if (stored) {
			try {
				cache.cachedItems = JSON.parse(
					stored as string,
				) as CachedEncryptedItem[];
				if (db) {
					await this.setCachedItems(cache.cachedItems, resolvedAccountId);
				}
			} catch {
				return null;
			}
		} else {
			cache.cachedItems = db ? [] : null;
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

		const db = await this.getItemCacheDb();
		if (!db) {
			const key = getAccountKey(resolvedAccountId, CACHED_VAULTS_SUFFIX);
			await chrome.storage.local.set({ [key]: JSON.stringify(vaults) });
			return;
		}

		const tx = db.transaction(ITEM_CACHE_VAULTS_STORE, "readwrite");
		const store = tx.objectStore(ITEM_CACHE_VAULTS_STORE);
		await this.deleteRecordsForAccount(store, resolvedAccountId);

		for (const vault of vaults) {
			await requestToPromise(
				store.put({
					id: this.getCacheRecordId(resolvedAccountId, vault.id),
					accountKey: resolvedAccountId,
					value: vault,
				} satisfies ItemCacheRecord<CachedVaultMetadata>),
			);
		}

		await waitForTransaction(tx);
		await chrome.storage.local.remove(
			getAccountKey(resolvedAccountId, CACHED_VAULTS_SUFFIX),
		);
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

		const db = await this.getItemCacheDb();
		if (db) {
			const records = await this.getRecordsForAccount<CachedVaultMetadata>(
				db,
				ITEM_CACHE_VAULTS_STORE,
				resolvedAccountId,
			);
			if (records.length > 0) {
				cache.cachedVaults = records.map((record) => record.value);
				return cache.cachedVaults;
			}
		}

		const legacyKey = getAccountKey(resolvedAccountId, CACHED_VAULTS_SUFFIX);
		const result = await chrome.storage.local.get(legacyKey);
		const stored = result[legacyKey];
		if (stored) {
			try {
				cache.cachedVaults = JSON.parse(
					stored as string,
				) as CachedVaultMetadata[];
				if (db) {
					await this.setCachedVaults(cache.cachedVaults, resolvedAccountId);
				}
			} catch {
				return null;
			}
		} else {
			cache.cachedVaults = db ? [] : null;
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

		const db = await this.getItemCacheDb();
		if (db) {
			const tx = db.transaction(ITEM_CACHE_METADATA_STORE, "readonly");
			const store = tx.objectStore(ITEM_CACHE_METADATA_STORE);
			const record = await requestToPromise(
				store.get(this.getMetadataRecordId(resolvedAccountId)) as IDBRequest<
					ItemCacheRecord<ItemCacheMetadata> | undefined
				>,
			);
			await waitForTransaction(tx);

			if (record?.value) {
				return record.value;
			}
		}

		const key = getAccountKey(resolvedAccountId, ITEM_CACHE_META_SUFFIX);
		const result = await chrome.storage.local.get(key);
		const stored = result[key];
		if (!stored) return null;

		try {
			const parsed = JSON.parse(stored as string) as ItemCacheMetadata;
			if (db) {
				await this.setItemCacheMetadata(parsed, resolvedAccountId);
			}
			return parsed;
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

		const db = await this.getItemCacheDb();
		if (!db) {
			const key = getAccountKey(resolvedAccountId, ITEM_CACHE_META_SUFFIX);
			await chrome.storage.local.set({ [key]: JSON.stringify(metadata) });
			return;
		}

		const tx = db.transaction(ITEM_CACHE_METADATA_STORE, "readwrite");
		await requestToPromise(
			tx.objectStore(ITEM_CACHE_METADATA_STORE).put({
				id: this.getMetadataRecordId(resolvedAccountId),
				accountKey: resolvedAccountId,
				value: metadata,
			} satisfies ItemCacheRecord<ItemCacheMetadata>),
		);
		await waitForTransaction(tx);
		await chrome.storage.local.remove(
			getAccountKey(resolvedAccountId, ITEM_CACHE_META_SUFFIX),
		);
	}

	async clearItemCache(accountId?: string): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		const cache = accountCaches.get(resolvedAccountId);
		if (cache) {
			cache.cachedItems = null;
			cache.cachedVaults = null;
		}

		const db = await this.getItemCacheDb();
		if (db) {
			await this.clearStoreForAccount(
				db,
				ITEM_CACHE_ITEMS_STORE,
				resolvedAccountId,
			);
			await this.clearStoreForAccount(
				db,
				ITEM_CACHE_VAULTS_STORE,
				resolvedAccountId,
			);
			await this.clearStoreForAccount(
				db,
				ITEM_CACHE_METADATA_STORE,
				resolvedAccountId,
			);
		}

		await chrome.storage.local.remove([
			getAccountKey(resolvedAccountId, CACHED_ITEMS_SUFFIX),
			getAccountKey(resolvedAccountId, CACHED_VAULTS_SUFFIX),
			getAccountKey(resolvedAccountId, ITEM_CACHE_META_SUFFIX),
		]);
	}

	async storeTravelModeCache(
		config: TravelModeConfig,
		accountId?: string,
	): Promise<void> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return;

		await chrome.storage.local.set({
			[getAccountKey(resolvedAccountId, TRAVEL_MODE_CACHE_SUFFIX)]:
				JSON.stringify(config),
		});
	}

	async getTravelModeCache(
		accountId?: string,
	): Promise<TravelModeConfig | null> {
		const resolvedAccountId = await this.resolveAccountId(accountId);
		if (!resolvedAccountId) return null;

		const result = await chrome.storage.local.get(
			getAccountKey(resolvedAccountId, TRAVEL_MODE_CACHE_SUFFIX),
		);
		const stored =
			result[getAccountKey(resolvedAccountId, TRAVEL_MODE_CACHE_SUFFIX)];
		if (typeof stored !== "string") return null;
		try {
			return JSON.parse(stored) as TravelModeConfig;
		} catch {
			return null;
		}
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
