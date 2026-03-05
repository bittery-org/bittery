/**
 * Web Storage Adapter
 * Uses localStorage for persistent data and sessionStorage for session data
 */
/// <reference lib="dom" />

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
const PINNED_KDF_PARAMS_STORAGE = "bittery_pinned_kdf_params";
const AUTO_LOCK_TIMEOUT_STORAGE = "bittery_auto_lock_timeout";
const ITEM_CACHE_DB_NAME = "bittery_item_cache";
const ITEM_CACHE_DB_VERSION = 2;
const ITEM_CACHE_ITEMS_STORE = "items";
const ITEM_CACHE_VAULTS_STORE = "vaults";
const ITEM_CACHE_ATTACHMENTS_STORE = "attachments";
const ITEM_CACHE_METADATA_STORE = "metadata";
const ITEM_CACHE_META_KEY = "item_cache_meta";

// In-memory cache for Master Unlock Key
let masterUnlockKeyCache: Uint8Array | null = null;
let masterUnlockKeyHandleCache: number | null = null;

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
 * Web Storage Adapter Implementation
 */
export class WebStorageAdapter implements IStorageAdapter {
	readonly platform = "web" as const;
	readonly supportsMultiAccount = false;
	readonly supportsBiometric = false;
	readonly supportsItemCache = true;
	private cacheDbPromise: Promise<IDBDatabase> | null = null;

	constructor(private crypto: CryptoProvider) {}

	private async getItemCacheDb(): Promise<IDBDatabase | null> {
		if (
			typeof window === "undefined" ||
			typeof window.indexedDB === "undefined"
		) {
			return null;
		}

		if (!this.cacheDbPromise) {
			this.cacheDbPromise = new Promise((resolve, reject) => {
				const request = window.indexedDB.open(
					ITEM_CACHE_DB_NAME,
					ITEM_CACHE_DB_VERSION,
				);

				request.onupgradeneeded = () => {
					const db = request.result;
					if (!db.objectStoreNames.contains(ITEM_CACHE_ITEMS_STORE)) {
						db.createObjectStore(ITEM_CACHE_ITEMS_STORE, { keyPath: "id" });
					}
					if (!db.objectStoreNames.contains(ITEM_CACHE_VAULTS_STORE)) {
						db.createObjectStore(ITEM_CACHE_VAULTS_STORE, { keyPath: "id" });
					}
					if (!db.objectStoreNames.contains(ITEM_CACHE_METADATA_STORE)) {
						db.createObjectStore(ITEM_CACHE_METADATA_STORE, { keyPath: "key" });
					}
					if (!db.objectStoreNames.contains(ITEM_CACHE_ATTACHMENTS_STORE)) {
						const attachmentsStore = db.createObjectStore(
							ITEM_CACHE_ATTACHMENTS_STORE,
							{ keyPath: "id" },
						);
						attachmentsStore.createIndex("by_item", "itemId", {
							unique: false,
						});
					}
				};

				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}

		return this.cacheDbPromise;
	}

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

		if (masterUnlockKeyHandleCache && this.crypto.exportKeyHandle) {
			return this.crypto.exportKeyHandle(masterUnlockKeyHandleCache);
		}

		// Try to restore from persistent storage if session is still valid
		if (await this.isSessionValid()) {
			const restoredHandle =
				await this.decryptStoredMasterUnlockKeyHandleInternal();
			if (restoredHandle) {
				masterUnlockKeyHandleCache = restoredHandle;
				if (this.crypto.exportKeyHandle) {
					return this.crypto.exportKeyHandle(restoredHandle);
				}
			}

			const restored = await this.decryptStoredMasterUnlockKeyInternal();
			if (restored) {
				masterUnlockKeyCache = restored;
				return restored;
			}
		}

		return null;
	}

	async setMasterUnlockKey(key: Uint8Array, _email?: string): Promise<void> {
		if (masterUnlockKeyHandleCache && this.crypto.destroyKeyHandle) {
			await this.crypto.destroyKeyHandle(masterUnlockKeyHandleCache);
		}
		masterUnlockKeyHandleCache = null;
		masterUnlockKeyCache = key;
	}

	async getMasterUnlockKeyHandle(_email?: string): Promise<number | null> {
		if (masterUnlockKeyHandleCache) {
			return masterUnlockKeyHandleCache;
		}

		if (!(await this.isSessionValid())) {
			return null;
		}

		const restoredHandle = await this.decryptStoredMasterUnlockKeyHandleInternal();
		if (restoredHandle) {
			masterUnlockKeyHandleCache = restoredHandle;
			return restoredHandle;
		}

		return null;
	}

	async setMasterUnlockKeyHandle(
		keyHandle: number,
		_email?: string,
	): Promise<void> {
		if (masterUnlockKeyHandleCache && this.crypto.destroyKeyHandle) {
			await this.crypto.destroyKeyHandle(masterUnlockKeyHandleCache);
		}
		masterUnlockKeyCache = null;
		masterUnlockKeyHandleCache = keyHandle;
	}

	async clearMasterUnlockKey(_email?: string): Promise<void> {
		masterUnlockKeyCache = null;
		if (masterUnlockKeyHandleCache && this.crypto.destroyKeyHandle) {
			await this.crypto.destroyKeyHandle(masterUnlockKeyHandleCache);
		}
		masterUnlockKeyHandleCache = null;
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

	async storeSessionDataWithMasterUnlockKeyHandle(
		keyHandle: number,
		email: string,
		userId: string,
		expiryMs: number = DEFAULT_SESSION_EXPIRY_MS,
		sessionId?: string,
	): Promise<void> {
		if (typeof window === "undefined") return;
		if (!this.crypto.encryptKeyHandleWithWrappingKey) {
			throw new Error(
				"Crypto provider does not support key-handle session storage",
			);
		}

		const deviceKey = await getDeviceKey();
		const now = Date.now();
		const encryptedMUK = await this.crypto.encryptKeyHandleWithWrappingKey(
			keyHandle,
			deviceKey,
		);

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
		if (masterUnlockKeyCache || masterUnlockKeyHandleCache) {
			return true;
		}

		const handle = await this.decryptStoredMasterUnlockKeyHandleInternal();
		if (handle) {
			masterUnlockKeyHandleCache = handle;
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

	async storePinnedKdfParams(
		params: KdfParams,
		_email?: string,
	): Promise<void> {
		if (typeof window !== "undefined") {
			localStorage.setItem(PINNED_KDF_PARAMS_STORAGE, JSON.stringify(params));
		}
	}

	async getPinnedKdfParams(_email?: string): Promise<KdfParams | null> {
		if (typeof window === "undefined") {
			return null;
		}
		const stored = localStorage.getItem(PINNED_KDF_PARAMS_STORAGE);
		if (!stored) {
			return null;
		}
		try {
			return JSON.parse(stored) as KdfParams;
		} catch {
			return null;
		}
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
	// Item Cache
	// ============================================================================

	async setCachedItems(
		items: CachedEncryptedItem[],
		_email?: string,
	): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(ITEM_CACHE_ITEMS_STORE, "readwrite");
		const store = tx.objectStore(ITEM_CACHE_ITEMS_STORE);
		await requestToPromise(store.clear());
		for (const item of items) {
			await requestToPromise(store.put(item));
		}
		await waitForTransaction(tx);
	}

	async getCachedItems(_email?: string): Promise<CachedEncryptedItem[] | null> {
		const db = await this.getItemCacheDb();
		if (!db) return null;

		const tx = db.transaction(ITEM_CACHE_ITEMS_STORE, "readonly");
		const store = tx.objectStore(ITEM_CACHE_ITEMS_STORE);
		const items = await requestToPromise(
			store.getAll() as IDBRequest<CachedEncryptedItem[]>,
		);
		await waitForTransaction(tx);
		return items ?? [];
	}

	async upsertCachedItem(
		item: CachedEncryptedItem,
		_email?: string,
	): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(ITEM_CACHE_ITEMS_STORE, "readwrite");
		await requestToPromise(tx.objectStore(ITEM_CACHE_ITEMS_STORE).put(item));
		await waitForTransaction(tx);
	}

	async removeCachedItem(itemId: string, _email?: string): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(ITEM_CACHE_ITEMS_STORE, "readwrite");
		await requestToPromise(
			tx.objectStore(ITEM_CACHE_ITEMS_STORE).delete(itemId),
		);
		await waitForTransaction(tx);
	}

	async setCachedVaults(
		vaults: CachedVaultMetadata[],
		_email?: string,
	): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(ITEM_CACHE_VAULTS_STORE, "readwrite");
		const store = tx.objectStore(ITEM_CACHE_VAULTS_STORE);
		await requestToPromise(store.clear());
		for (const vault of vaults) {
			await requestToPromise(store.put(vault));
		}
		await waitForTransaction(tx);
	}

	async getCachedVaults(
		_email?: string,
	): Promise<CachedVaultMetadata[] | null> {
		const db = await this.getItemCacheDb();
		if (!db) return null;

		const tx = db.transaction(ITEM_CACHE_VAULTS_STORE, "readonly");
		const store = tx.objectStore(ITEM_CACHE_VAULTS_STORE);
		const vaults = await requestToPromise(
			store.getAll() as IDBRequest<CachedVaultMetadata[]>,
		);
		await waitForTransaction(tx);
		return vaults ?? [];
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		_email?: string,
	): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(ITEM_CACHE_VAULTS_STORE, "readwrite");
		await requestToPromise(tx.objectStore(ITEM_CACHE_VAULTS_STORE).put(vault));
		await waitForTransaction(tx);
	}

	async removeCachedVault(vaultId: string, _email?: string): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(
			[ITEM_CACHE_VAULTS_STORE, ITEM_CACHE_ITEMS_STORE],
			"readwrite",
		);
		await requestToPromise(
			tx.objectStore(ITEM_CACHE_VAULTS_STORE).delete(vaultId),
		);

		const itemStore = tx.objectStore(ITEM_CACHE_ITEMS_STORE);
		const items = await requestToPromise(
			itemStore.getAll() as IDBRequest<CachedEncryptedItem[]>,
		);
		for (const item of items) {
			if (item.vaultId === vaultId) {
				await requestToPromise(itemStore.delete(item.id));
			}
		}

		await waitForTransaction(tx);
	}

	async getItemCacheMetadata(
		_email?: string,
	): Promise<ItemCacheMetadata | null> {
		const db = await this.getItemCacheDb();
		if (!db) return null;

		const tx = db.transaction(ITEM_CACHE_METADATA_STORE, "readonly");
		const store = tx.objectStore(ITEM_CACHE_METADATA_STORE);
		const result = await requestToPromise(
			store.get(ITEM_CACHE_META_KEY) as IDBRequest<
				{ key: string; value: ItemCacheMetadata } | undefined
			>,
		);
		await waitForTransaction(tx);

		return result?.value ?? null;
	}

	async setItemCacheMetadata(
		metadata: ItemCacheMetadata,
		_email?: string,
	): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(ITEM_CACHE_METADATA_STORE, "readwrite");
		await requestToPromise(
			tx.objectStore(ITEM_CACHE_METADATA_STORE).put({
				key: ITEM_CACHE_META_KEY,
				value: metadata,
			}),
		);
		await waitForTransaction(tx);
	}

	async clearItemCache(_email?: string): Promise<void> {
		const db = await this.getItemCacheDb();
		if (!db) return;

		const tx = db.transaction(
			[
				ITEM_CACHE_ITEMS_STORE,
				ITEM_CACHE_VAULTS_STORE,
				ITEM_CACHE_METADATA_STORE,
			],
			"readwrite",
		);
		await requestToPromise(tx.objectStore(ITEM_CACHE_ITEMS_STORE).clear());
		await requestToPromise(tx.objectStore(ITEM_CACHE_VAULTS_STORE).clear());
		await requestToPromise(tx.objectStore(ITEM_CACHE_METADATA_STORE).clear());
		await waitForTransaction(tx);
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
		if (masterUnlockKeyHandleCache && this.crypto.destroyKeyHandle) {
			await this.crypto.destroyKeyHandle(masterUnlockKeyHandleCache);
		}
		masterUnlockKeyHandleCache = null;
		this.clearStoredSession();
	}

	async clearAllStoredData(_email?: string): Promise<void> {
		if (typeof window === "undefined") return;
		localStorage.removeItem(SECRET_KEY_STORAGE);
		localStorage.removeItem(SESSION_DATA_STORAGE);
		localStorage.removeItem(DEVICE_KEY_STORAGE);
		localStorage.removeItem(PINNED_KDF_PARAMS_STORAGE);
		await this.clearSession();
		await this.clearItemCache();
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
		if (masterUnlockKeyHandleCache && this.crypto.destroyKeyHandle) {
			await this.crypto.destroyKeyHandle(masterUnlockKeyHandleCache);
		}
		masterUnlockKeyHandleCache = null;
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
		if (!masterUnlockKeyCache && !masterUnlockKeyHandleCache) return [];

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
		if (masterUnlockKeyCache) {
			return masterUnlockKeyCache;
		}

		if (masterUnlockKeyHandleCache && this.crypto.exportKeyHandle) {
			return this.crypto.exportKeyHandle(masterUnlockKeyHandleCache);
		}

		const handle = await this.decryptStoredMasterUnlockKeyHandleInternal();
		if (handle) {
			masterUnlockKeyHandleCache = handle;
			if (this.crypto.exportKeyHandle) {
				return this.crypto.exportKeyHandle(handle);
			}
		}

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

	private async decryptStoredMasterUnlockKeyHandleInternal(): Promise<number | null> {
		if (!this.crypto.decryptKeyHandleWithWrappingKey) {
			return null;
		}

		const sessionData = await this.getStoredSessionData();
		if (!sessionData) return null;

		try {
			const deviceKey = await getDeviceKey();
			return await this.crypto.decryptKeyHandleWithWrappingKey(
				sessionData.encryptedMasterUnlockKey,
				deviceKey,
			);
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
