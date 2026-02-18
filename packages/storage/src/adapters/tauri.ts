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
	EncryptedData,
	ItemCacheMetadata,
} from "@bittery/types";
import type { Store } from "@tauri-apps/plugin-store";
import type { IStorageAdapter } from "../adapter";
import type { CryptoProvider } from "../crypto-provider";
import {
	type AccountMetadata,
	type ActiveAccount,
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	MASTER_PASSWORD_REENTRY_PERIOD_MS,
	type StoredSessionData,
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
	cachedItems: CachedEncryptedItem[] | null;
	cachedVaults: CachedVaultMetadata[] | null;
}

// In-memory caches - keyed by email
const accountCaches: Map<string, AccountCache> = new Map();

// Cache for active account to avoid repeated IPC calls
let cachedActiveAccount: ActiveAccount | undefined;

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

		// Pre-load active account into cache to avoid repeated IPC calls
		if (this.store) {
			const stored = await this.store.get<string>(ACTIVE_ACCOUNT_KEY);
			if (!stored) {
				cachedActiveAccount = null;
			} else if (stored === "all") {
				cachedActiveAccount = { type: "all" };
			} else {
				cachedActiveAccount = { type: "single", email: stored };
			}
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

		const account = await this.getActiveAccount();
		if (!account || account.type === "all") return null;
		return account.email;
	}

	private getAccountCache(email: string): AccountCache {
		const key = email.toLowerCase();
		let cache = accountCaches.get(key);
		if (!cache) {
			cache = {
				authToken: null,
				vaultKeys: null,
				masterUnlockKey: null,
				cachedItems: null,
				cachedVaults: null,
			};
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

	async clearMasterUnlockKey(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const cache = this.getAccountCache(resolvedEmail);
		cache.masterUnlockKey = null;

		// Update lock state marker for Rust lock-status endpoint
		await this.updateLockStateMarker();
	}

	async storeSessionData(
		masterUnlockKey: Uint8Array,
		email: string,
		userId: string,
		expiryMs: number = DEFAULT_SESSION_EXPIRY_MS,
		sessionId?: string,
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
			sessionId,
			expiresAt: now + expiryMs,
			createdAt: now,
			biometricEnabled,
			lastMasterPasswordEntry: now, // Track when user last entered master password
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

	async getActiveAccount(): Promise<ActiveAccount> {
		// Return cached value if available to avoid repeated IPC calls
		if (cachedActiveAccount !== undefined) {
			return cachedActiveAccount;
		}

		const store = await this.getStore();
		const stored = await store.get<string>(ACTIVE_ACCOUNT_KEY);

		let account: ActiveAccount;
		if (!stored) {
			account = null;
		} else if (stored === "all") {
			account = { type: "all" };
		} else {
			account = { type: "single", email: stored };
		}

		cachedActiveAccount = account;
		return account;
	}

	async getActiveAccountUserId(): Promise<string | null> {
		const account = await this.getActiveAccount();
		if (!account || account.type === "all") return null;

		const sessionData = await this.getStoredSessionData(account.email);
		return sessionData?.userId ?? null;
	}

	async setActiveAccount(account: ActiveAccount): Promise<void> {
		const store = await this.getStore();
		const normalizedValue = !account
			? null
			: account.type === "all"
				? "all"
				: account.email.toLowerCase();

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
			const accountMeta = accountsList.accounts.find(
				(a) => a.email.toLowerCase() === account.email.toLowerCase(),
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
		const currentAccount = await this.getActiveAccount();
		if (
			currentAccount?.type === "single" &&
			currentAccount.email === resolvedEmail
		) {
			cachedActiveAccount = null;
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
		await store.delete(getAccountKey(resolvedEmail, "cached_items"));
		await store.delete(getAccountKey(resolvedEmail, "cached_vaults"));
		await store.delete(getAccountKey(resolvedEmail, "item_cache_meta"));
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

	async storeAutoLockTimeout(
		timeoutMs: number,
		_email?: string,
	): Promise<void> {
		const store = await this.getStore();
		await store.set(AUTO_LOCK_TIMEOUT_KEY, timeoutMs);
		await this.clearLegacyAutoLockTimeoutKeys();
		await store.save();
	}

	async getAutoLockTimeout(email?: string): Promise<number | null> {
		const store = await this.getStore();
		const globalTimeout = await store.get<number>(AUTO_LOCK_TIMEOUT_KEY);
		if (typeof globalTimeout === "number") {
			return globalTimeout;
		}

		// Legacy migration: account-scoped timeout -> app-scoped timeout.
		const legacyTimeout = await this.getLegacyAutoLockTimeout(email);
		if (legacyTimeout === null) {
			return null;
		}

		await store.set(AUTO_LOCK_TIMEOUT_KEY, legacyTimeout);
		await this.clearLegacyAutoLockTimeoutKeys();
		await store.save();
		return legacyTimeout;
	}

	async getAutoLockTimeoutOrDefault(email?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(email);
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
		email?: string,
	): Promise<number | null> {
		const store = await this.getStore();
		const candidateEmails = new Set<string>();

		if (email) {
			candidateEmails.add(email.toLowerCase());
		}

		const resolvedEmail = await this.resolveEmail(email);
		if (resolvedEmail) {
			candidateEmails.add(resolvedEmail);
		}

		if (candidateEmails.size === 0) {
			const accountsList = await this.getAccountsListInternal();
			for (const account of accountsList.accounts) {
				candidateEmails.add(account.email.toLowerCase());
			}
		}

		for (const candidateEmail of candidateEmails) {
			const legacyKey = getAccountKey(candidateEmail, "auto_lock_timeout");
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
				getAccountKey(account.email.toLowerCase(), "auto_lock_timeout"),
			);
		}
	}

	private formatMasterPasswordReentryPeriod(periodMs: number): string {
		const days = Math.round(periodMs / (24 * 60 * 60 * 1000));
		return `${days} day${days === 1 ? "" : "s"}`;
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

		// Clear item cache (items require MUK for vault key decryption)
		await this.clearItemCache(resolvedEmail);

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

	async authenticateWithBiometricEnhanced(
		reason = "Unlock Bittery",
		email?: string,
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
			const resolvedEmail = await this.resolveEmail(email);
			if (!resolvedEmail) {
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
			const isEnabled = await this.isBiometricEnabled(resolvedEmail);
			if (!isEnabled) {
				return {
					success: false,
					error: "not_enabled",
					message: "Biometric authentication is not enabled for this account",
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

			// Check if master password re-entry is required by configured policy
			if (await this.isMasterPasswordReentryRequired(resolvedEmail)) {
				const reentryPeriodMs = await this.getMasterPasswordReentryPeriodMs();
				return {
					success: false,
					error: "master_password_required",
					message:
						`For security, please enter your master password. This is required every ${this.formatMasterPasswordReentryPeriod(reentryPeriodMs)}.`,
				};
			}

			await this.biometryModule.authenticate(reason);

			// Update last biometric auth timestamp
			const store = await this.getStore();
			const key = getAccountKey(resolvedEmail, "last_biometric_auth");
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

	async isMasterPasswordReentryRequired(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		const sessionData = await this.getStoredSessionData(resolvedEmail);
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

	async updateLastMasterPasswordEntry(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const sessionData = await this.getStoredSessionData(resolvedEmail);
		if (!sessionData) return;

		// Update the timestamp
		sessionData.lastMasterPasswordEntry = Date.now();

		// Persist the updated session data
		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "session_data");
		await store.set(key, JSON.stringify(sessionData));
		await store.save();
	}

	/**
	 * Public wrapper for decrypting stored MUK
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

	private async decryptStoredMasterUnlockKeyInternal(
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
	// Item Cache
	// ============================================================================

	async setCachedItems(
		items: CachedEncryptedItem[],
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const cache = this.getAccountCache(resolvedEmail);
		cache.cachedItems = items;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "cached_items");
		await store.set(key, JSON.stringify(items));
		await store.save();
	}

	async getCachedItems(email?: string): Promise<CachedEncryptedItem[] | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.cachedItems) {
			return cache.cachedItems;
		}

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "cached_items");
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
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		let items = await this.getCachedItems(resolvedEmail);
		if (!items) {
			items = [];
		}

		const index = items.findIndex((i) => i.id === item.id);
		if (index >= 0) {
			items[index] = item;
		} else {
			items.push(item);
		}

		await this.setCachedItems(items, resolvedEmail);
	}

	async removeCachedItem(itemId: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const items = await this.getCachedItems(resolvedEmail);
		if (!items) return;

		const filtered = items.filter((i) => i.id !== itemId);
		await this.setCachedItems(filtered, resolvedEmail);
	}

	async setCachedVaults(
		vaults: CachedVaultMetadata[],
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const cache = this.getAccountCache(resolvedEmail);
		cache.cachedVaults = vaults;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "cached_vaults");
		await store.set(key, JSON.stringify(vaults));
		await store.save();
	}

	async getCachedVaults(email?: string): Promise<CachedVaultMetadata[] | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.cachedVaults) {
			return cache.cachedVaults;
		}

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "cached_vaults");
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
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		let vaults = await this.getCachedVaults(resolvedEmail);
		if (!vaults) {
			vaults = [];
		}

		const index = vaults.findIndex((v) => v.id === vault.id);
		if (index >= 0) {
			vaults[index] = vault;
		} else {
			vaults.push(vault);
		}

		await this.setCachedVaults(vaults, resolvedEmail);
	}

	async removeCachedVault(vaultId: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		// Remove the vault metadata
		const vaults = await this.getCachedVaults(resolvedEmail);
		if (vaults) {
			const filtered = vaults.filter((v) => v.id !== vaultId);
			await this.setCachedVaults(filtered, resolvedEmail);
		}

		// Also remove all items belonging to this vault
		const items = await this.getCachedItems(resolvedEmail);
		if (items) {
			const filtered = items.filter((i) => i.vaultId !== vaultId);
			await this.setCachedItems(filtered, resolvedEmail);
		}
	}

	async getItemCacheMetadata(
		email?: string,
	): Promise<ItemCacheMetadata | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "item_cache_meta");
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
		email?: string,
	): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const store = await this.getStore();
		const key = getAccountKey(resolvedEmail, "item_cache_meta");
		await store.set(key, JSON.stringify(metadata));
		await store.save();
	}

	async clearItemCache(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		const cache = this.getAccountCache(resolvedEmail);
		cache.cachedItems = null;
		cache.cachedVaults = null;

		const store = await this.getStore();
		await store.delete(getAccountKey(resolvedEmail, "cached_items"));
		await store.delete(getAccountKey(resolvedEmail, "cached_vaults"));
		await store.delete(getAccountKey(resolvedEmail, "item_cache_meta"));
		await store.save();
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
	 * Clear app-wide auto-lock timeout preference
	 */
	async clearAutoLockTimeout(_email?: string): Promise<void> {
		const store = await this.getStore();
		await store.delete(AUTO_LOCK_TIMEOUT_KEY);
		await this.clearLegacyAutoLockTimeoutKeys();
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
	 * Update the lock state marker in store for Rust lock-status endpoint
	 * This marker reflects which accounts have MUKs in memory (true source of truth)
	 */
	private async updateLockStateMarker(): Promise<void> {
		const unlockedEmails = await this.getUnlockedAccounts();
		const store = await this.getStore();
		await store.set(
			"bittery_unlocked_accounts",
			JSON.stringify(unlockedEmails),
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
			const biometricKey = getAccountKey(account.email, "last_biometric_auth");
			await store.delete(biometricKey);
		}

		// Update lock state marker (for Rust lock-status endpoint)
		await store.set("bittery_unlocked_accounts", JSON.stringify([]));
		await store.save();
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
			// No account supports biometric
			for (const account of accountsList) {
				failed.push({
					email: account.email,
					error: "Biometric authentication not available",
				});
			}
			return { unlocked, failed };
		}

		// FORCE biometric authentication (ignore grace period)
		// This ensures we ALWAYS show the prompt when explicitly unlocking
		const authenticated = await this.authenticateWithBiometric(
			"Unlock all accounts",
			firstAccountEmail,
		);

		if (!authenticated) {
			// Biometric authentication failed or was cancelled
			for (const account of accountsList) {
				failed.push({
					email: account.email,
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
					account.email,
					true, // skipBiometric = true (we already authenticated above)
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
): TauriStorageAdapter {
	return new TauriStorageAdapter(crypto);
}
