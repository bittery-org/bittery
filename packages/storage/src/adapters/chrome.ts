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
	type ActiveAccount,
	type BiometricAuthResult,
	DEFAULT_SESSION_EXPIRY_MS,
	type StoredSessionData,
	type VaultKeyData,
} from "../types";

// Global storage keys (shared across all accounts)
const DEVICE_KEY_STORAGE = "bittery_device_key";
const ACTIVE_ACCOUNT_KEY = "bittery_active_account";
const ACCOUNTS_LIST_KEY = "bittery_accounts_list";

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

// Cache for active account to avoid repeated storage reads
let cachedActiveAccount: ActiveAccount | undefined;

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
	readonly supportsMultiAccount = true;
	readonly supportsBiometric = false;

	constructor(private crypto: CryptoProvider) {}

	async initialize(): Promise<void> {
		// Listen for storage changes to keep cache in sync across contexts
		chrome.storage.onChanged.addListener((changes, areaName) => {
			if (areaName !== "local") return;

			// Clear active account cache if it changed
			if (ACTIVE_ACCOUNT_KEY in changes) {
				console.log(
					"[storage-chrome] Active account changed in storage, clearing cache",
				);
				cachedActiveAccount = undefined;
			}
		});
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
			const restored =
				await this.decryptStoredMasterUnlockKeyInternal(resolvedEmail);
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
		const deviceKey = await getDeviceKey();
		const now = Date.now();

		// Encrypt Master Unlock Key with device key
		const mukBase64 = arrayBufferToBase64(masterUnlockKey);
		const encryptedMUK = await this.crypto.encrypt(mukBase64, deviceKey);

		const sessionData: StoredSessionData = {
			encryptedMasterUnlockKey: encryptedMUK,
			email: resolvedEmail,
			userId,
			expiresAt: now + expiryMs,
			createdAt: now,
		};

		const key = getAccountKey(resolvedEmail, "session_data");
		await chrome.storage.local.set({
			[key]: JSON.stringify(sessionData),
		});
	}

	async tryRestoreSession(
		_skipBiometric?: boolean,
		email?: string,
	): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) {
			console.log("[storage-chrome] tryRestoreSession: No email resolved");
			return false;
		}

		console.log(`[storage-chrome] tryRestoreSession: Starting for ${resolvedEmail}`);

		if (!(await this.isSessionValid(resolvedEmail))) {
			console.log(`[storage-chrome] tryRestoreSession: Session not valid for ${resolvedEmail}`);
			return false;
		}

		// First check if MUK is already in memory cache (e.g., after login)
		const cache = this.getAccountCache(resolvedEmail);
		if (cache.masterUnlockKey) {
			console.log(`[storage-chrome] tryRestoreSession: MUK already in memory for ${resolvedEmail}`);
			// Also ensure auth token and vault keys are in cache
			if (!cache.authToken) {
				const authToken = await this.getAuthToken(resolvedEmail);
				if (authToken) {
					cache.authToken = authToken;
				}
			}
			if (!cache.vaultKeys) {
				const vaultKeys = await this.getVaultKeys(resolvedEmail);
				if (vaultKeys) {
					cache.vaultKeys = vaultKeys;
				}
			}
			return true;
		}

		console.log(`[storage-chrome] tryRestoreSession: Attempting to decrypt stored MUK for ${resolvedEmail}`);

		// Otherwise, try to decrypt from persistent storage
		const masterUnlockKey =
			await this.decryptStoredMasterUnlockKeyInternal(resolvedEmail);
		if (!masterUnlockKey) {
			console.error(`[storage-chrome] tryRestoreSession: Failed to decrypt MUK for ${resolvedEmail}`);
			return false;
		}

		console.log(`[storage-chrome] tryRestoreSession: MUK decrypted successfully for ${resolvedEmail}`);

		await this.setMasterUnlockKey(masterUnlockKey, resolvedEmail);

		// Also restore auth token and vault keys into cache
		// Both are required for a fully functional session
		const authToken = await this.getAuthToken(resolvedEmail);
		if (!authToken) {
			console.error(
				`[storage-chrome] Cannot restore session for ${resolvedEmail}: auth token not found in storage`,
			);
			return false;
		}
		cache.authToken = authToken;

		const vaultKeys = await this.getVaultKeys(resolvedEmail);
		if (!vaultKeys || vaultKeys.length === 0) {
			console.error(
				`[storage-chrome] Cannot restore session for ${resolvedEmail}: vault keys not found in storage`,
			);
			return false;
		}
		cache.vaultKeys = vaultKeys;

		console.log(`[storage-chrome] tryRestoreSession: Successfully restored session for ${resolvedEmail}`);
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
		await chrome.storage.local.set({ [key]: secretKey });
	}

	async getStoredSecretKey(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "secret_key");
		const result = await chrome.storage.local.get(key);
		return (result[key] as string | undefined) || null;
	}

	async storeAuthToken(token: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const cache = this.getAccountCache(resolvedEmail);
		cache.authToken = token;

		// Persist to local storage (not session) so it survives service worker restarts
		const key = getAccountKey(resolvedEmail, "jwt_token");
		await chrome.storage.local.set({ [key]: token });
	}

	async getAuthToken(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.authToken) {
			return cache.authToken;
		}

		// Try to restore from local storage
		const key = getAccountKey(resolvedEmail, "jwt_token");
		const result = await chrome.storage.local.get(key);
		const token = (result[key] as string | undefined) || null;
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
			"[storage-chrome] Storing vault keys:",
			vaultKeys.length,
			"keys",
		);

		const cache = this.getAccountCache(resolvedEmail);
		cache.vaultKeys = vaultKeys;

		const key = getAccountKey(resolvedEmail, "vault_keys");
		try {
			// Store in local storage (not session) to persist across service worker restarts
			await chrome.storage.local.set({
				[key]: JSON.stringify(vaultKeys),
			});
			console.log("[storage-chrome] Vault keys stored successfully");
		} catch (error) {
			console.error("[storage-chrome] Failed to store vault keys:", error);
			throw error;
		}
	}

	async getVaultKeys(email?: string): Promise<VaultKeyData[] | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const cache = this.getAccountCache(resolvedEmail);
		if (cache.vaultKeys) {
			return cache.vaultKeys;
		}

		console.log("[storage-chrome] Getting vault keys from local storage");
		const key = getAccountKey(resolvedEmail, "vault_keys");
		const result = await chrome.storage.local.get(key);
		const stored = result[key];
		console.log(
			"[storage-chrome] Vault keys found:",
			!!stored,
			stored ? `(${JSON.parse(stored as string).length} keys)` : "(none)",
		);

		if (stored) {
			cache.vaultKeys = JSON.parse(stored as string);
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
		await chrome.storage.session.set({
			[key]: encryptedPrivateKey,
		});
	}

	async getEncryptedPrivateKey(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "encrypted_private_key");
		const result = await chrome.storage.session.get(key);
		return (result[key] as string | undefined) || null;
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
		const stored = result[ACTIVE_ACCOUNT_KEY];

		let account: ActiveAccount;
		if (!stored) {
			account = null;
		} else if (stored === "all") {
			account = { type: "all" };
		} else {
			account = { type: "single", email: stored as string };
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
		const normalizedValue = !account
			? null
			: account.type === "all"
				? "all"
				: account.email.toLowerCase();

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
			const accountMeta = accountsList.accounts.find(
				(a) => a.email.toLowerCase() === account.email.toLowerCase(),
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
		console.log(result);

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

		const existingIndex = accountsList.accounts.findIndex(
			(a) => a.email.toLowerCase() === metadata.email.toLowerCase(),
		);

		if (existingIndex >= 0) {
			accountsList.accounts[existingIndex] = metadata;
		} else {
			accountsList.accounts.push(metadata);
		}

		await chrome.storage.local.set({
			[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
		});
	}

	async removeAccount(email: string): Promise<void> {
		const resolvedEmail = email.toLowerCase();

		// Delete all namespaced keys for this account
		const keysToRemove = [
			getAccountKey(resolvedEmail, "secret_key"),
			getAccountKey(resolvedEmail, "session_data"),
			getAccountKey(resolvedEmail, "jwt_token"),
			getAccountKey(resolvedEmail, "vault_keys"),
			getAccountKey(resolvedEmail, "server_url"),
			getAccountKey(resolvedEmail, "encrypted_private_key"),
			getAccountKey(resolvedEmail, "auto_lock_timeout"),
		];

		await chrome.storage.local.remove(keysToRemove);
		// Remove JWT and encrypted private key from session storage
		await chrome.storage.session.remove([
			getAccountKey(resolvedEmail, "jwt_token"),
			getAccountKey(resolvedEmail, "encrypted_private_key"),
		]);

		// Remove vault keys from local storage
		await chrome.storage.local.remove([
			getAccountKey(resolvedEmail, "vault_keys"),
		]);

		this.clearAccountCache(resolvedEmail);

		// Remove from accounts list
		const accountsList = await this.getAccountsListInternal();
		accountsList.accounts = accountsList.accounts.filter(
			(a) => a.email.toLowerCase() !== resolvedEmail,
		);
		await chrome.storage.local.set({
			[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
		});
	}

	// ============================================================================
	// Settings
	// ============================================================================

	async storeAutoLockTimeout(timeoutMs: number, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
		await chrome.storage.local.set({ [key]: timeoutMs });
	}

	async getAutoLockTimeout(email?: string): Promise<number | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "auto_lock_timeout");
		const result = await chrome.storage.local.get(key);
		const stored = result[key];
		if (stored !== undefined && typeof stored === "number") {
			return stored;
		}
		return null;
	}

	async getAutoLockTimeoutOrDefault(email?: string): Promise<number> {
		const timeout = await this.getAutoLockTimeout(email);
		// Default: 10 minutes
		return timeout ?? 10 * 60 * 1000;
	}

	async storeServerUrl(serverUrl: string, email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) throw new Error("No account specified");

		const key = getAccountKey(resolvedEmail, "server_url");
		await chrome.storage.local.set({ [key]: serverUrl });
	}

	async getServerUrl(email?: string): Promise<string | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		const key = getAccountKey(resolvedEmail, "server_url");
		const result = await chrome.storage.local.get(key);
		return (result[key] as string | undefined) || null;
	}

	// ============================================================================
	// Auth State
	// ============================================================================

	async isAuthenticated(_email?: string): Promise<boolean> {
		// If email is provided, check that specific account
		if (_email) {
			const token = await this.getAuthToken(_email);
			return token !== null;
		}

		// For multi-account: check if ANY account is authenticated
		const accounts = await this.getAccountsList();
		if (accounts.length === 0) {
			return false;
		}

		// Check if any account has an auth token
		for (const account of accounts) {
			const token = await this.getAuthToken(account.email);
			if (token) {
				return true;
			}
		}

		return false;
	}

	async canQuickUnlock(_email?: string): Promise<boolean> {
		// If email is provided, check that specific account
		if (_email) {
			const hasSecretKey = (await this.getStoredSecretKey(_email)) !== null;
			const sessionValid = await this.isSessionValid(_email);
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
				(await this.getStoredSecretKey(account.email)) !== null;
			const sessionValid = await this.isSessionValid(account.email);
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

	async clearSession(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return;

		this.clearAccountCache(resolvedEmail);

		// Clear session storage keys
		// Remove JWT and encrypted private key from session storage
		await chrome.storage.session.remove([
			getAccountKey(resolvedEmail, "jwt_token"),
			getAccountKey(resolvedEmail, "encrypted_private_key"),
		]);

		// Remove vault keys from local storage
		await chrome.storage.local.remove([
			getAccountKey(resolvedEmail, "vault_keys"),
		]);
	}

	async clearAllStoredData(email?: string): Promise<void> {
		const resolvedEmail = await this.resolveEmail(email);
		if (resolvedEmail) {
			await this.removeAccount(resolvedEmail);
		}
	}

	// ============================================================================
	// Extended Session Management (unified interface)
	// ============================================================================

	async getStoredSessionData(
		email?: string,
	): Promise<StoredSessionData | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;

		try {
			const key = getAccountKey(resolvedEmail, "session_data");
			const result = await chrome.storage.local.get(key);
			const stored = result[key];

			if (!stored) return null;
			return JSON.parse(stored as string) as StoredSessionData;
		} catch {
			return null;
		}
	}

	async hasStoredSecretKey(email?: string): Promise<boolean> {
		const secretKey = await this.getStoredSecretKey(email);
		return secretKey != null;
	}

	async lockAllAccounts(): Promise<void> {
		accountCaches.clear();
	}

	async getAccountMetadata(email: string): Promise<AccountMetadata | null> {
		const accountsList = await this.getAccountsList();
		return (
			accountsList.find((a) => a.email.toLowerCase() === email.toLowerCase()) ??
			null
		);
	}

	async getUnlockedAccounts(): Promise<string[]> {
		console.log(
			"[storage-chrome] getUnlockedAccounts - accountCaches size:",
			accountCaches.size,
		);

		// If cache is empty (e.g., after service worker restart), try to restore from storage
		const accounts = await this.getAccountsList();

		const unlockedEmails: string[] = [];
		for (const account of accounts) {
			const email = account.email.toLowerCase();

			// Try to get MUK (will restore from storage if needed)
			const muk = await this.getMasterUnlockKey(email);
			console.log(`[storage-chrome] Account ${email} - has MUK:`, !!muk);

			if (muk) {
				unlockedEmails.push(email);
			}
		}

		console.log("[storage-chrome] Unlocked accounts:", unlockedEmails);
		return unlockedEmails;
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
		email?: string,
		_skipBiometric?: boolean,
	): Promise<Uint8Array | null> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return null;
		return this.decryptStoredMasterUnlockKeyInternal(resolvedEmail);
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	private async decryptStoredMasterUnlockKeyInternal(
		email: string,
	): Promise<Uint8Array | null> {
		const sessionData = await this.getStoredSessionData(email);
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
		const muk = await this.getMasterUnlockKey(_email);
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

	// ============================================================================
	// Biometric (extension queries desktop app for biometric support)
	// ============================================================================

	/**
	 * Check if biometric unlock is enabled for this account.
	 * For extensions, this checks the stored account metadata which should be
	 * synced with the desktop app's biometric status.
	 */
	async isBiometricEnabled(email?: string): Promise<boolean> {
		const resolvedEmail = await this.resolveEmail(email);
		if (!resolvedEmail) return false;

		const accounts = await this.getAccountsList();
		const account = accounts.find(
			(a) => a.email.toLowerCase() === resolvedEmail.toLowerCase(),
		);

		return account?.biometricEnabled ?? false;
	}

	/**
	 * Update the biometric enabled status for an account.
	 * This syncs the local status with the desktop app's biometric setting.
	 */
	async updateBiometricEnabled(email: string, enabled: boolean): Promise<void> {
		const accountsList = await this.getAccountsListInternal();
		const account = accountsList.accounts.find(
			(a) => a.email.toLowerCase() === email.toLowerCase(),
		);

		if (account) {
			account.biometricEnabled = enabled;
			await chrome.storage.local.set({
				[ACCOUNTS_LIST_KEY]: JSON.stringify(accountsList),
			});
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
