/**
 * Desktop Client Service
 * Handles communication with desktop app for session data and decryption
 */

const DESKTOP_BASE_URL = "http://localhost:48765";
const CACHE_TTL_MS = 5000; // 5 seconds

interface SessionAccount {
	email: string;
	auth_token: string;
	expires_at?: number;
	user_id?: string;
}

interface SessionDataResponse {
	accounts: SessionAccount[];
	active_account: string | null;
	timestamp: number;
}

interface VaultKeysResponse {
	email: string;
	vault_keys: string; // JSON string of vault keys array
}

interface DecryptItemRequest {
	id: string;
	vaultId: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
}

interface DecryptedItem {
	id: string;
	decrypted_data: string; // JSON string
}

interface DecryptItemsResponse {
	decrypted_items: DecryptedItem[];
	failed: Array<{ id: string; error: string }>;
}

interface CachedData<T> {
	data: T;
	timestamp: number;
}

class DesktopClient {
	private sessionDataCache: CachedData<SessionDataResponse> | null = null;
	private vaultKeysCache: Map<string, CachedData<VaultKeysResponse>> =
		new Map();
	private decryptedItemsCache: Map<string, CachedData<DecryptedItem>> =
		new Map();

	/**
	 * Check if desktop is available by pinging lock-status endpoint
	 */
	async isAvailable(): Promise<boolean> {
		try {
			const response = await fetch(
				`${DESKTOP_BASE_URL}/native-bridge/lock-status`,
				{
					method: "GET",
					signal: AbortSignal.timeout(2000), // 2 second timeout
				},
			);
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Get session data for all unlocked accounts (cached 5s)
	 */
	async getSessionData(): Promise<SessionDataResponse | null> {
		// Check cache
		if (this.sessionDataCache) {
			const age = Date.now() - this.sessionDataCache.timestamp;
			if (age < CACHE_TTL_MS) {
				console.log("[desktop-client] Returning cached session data");
				return this.sessionDataCache.data;
			}
		}

		try {
			const response = await fetch(
				`${DESKTOP_BASE_URL}/native-bridge/session-data`,
				{
					method: "GET",
					signal: AbortSignal.timeout(5000),
				},
			);

			if (!response.ok) {
				console.error(
					"[desktop-client] Failed to fetch session data:",
					response.status,
				);
				return null;
			}

			const data = (await response.json()) as SessionDataResponse;
			this.sessionDataCache = { data, timestamp: Date.now() };
			console.log(
				"[desktop-client] Fetched session data:",
				data.accounts.length,
				"accounts",
			);
			return data;
		} catch (error) {
			console.error("[desktop-client] Error fetching session data:", error);
			return null;
		}
	}

	/**
	 * Get vault keys for a specific account
	 */
	async getVaultKeys(email: string): Promise<VaultKeysResponse | null> {
		// Check cache
		const cached = this.vaultKeysCache.get(email.toLowerCase());
		if (cached) {
			const age = Date.now() - cached.timestamp;
			if (age < CACHE_TTL_MS) {
				console.log("[desktop-client] Returning cached vault keys for", email);
				return cached.data;
			}
		}

		try {
			const url = `${DESKTOP_BASE_URL}/native-bridge/vault-keys?email=${encodeURIComponent(email)}`;
			const response = await fetch(url, {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				console.error(
					"[desktop-client] Failed to fetch vault keys:",
					response.status,
				);
				return null;
			}

			const data = (await response.json()) as VaultKeysResponse;
			this.vaultKeysCache.set(email.toLowerCase(), {
				data,
				timestamp: Date.now(),
			});
			console.log("[desktop-client] Fetched vault keys for", email);
			return data;
		} catch (error) {
			console.error("[desktop-client] Error fetching vault keys:", error);
			return null;
		}
	}

	/**
	 * Decrypt items using desktop's crypto (bulk operation)
	 */
	async decryptItems(
		email: string,
		items: DecryptItemRequest[],
	): Promise<DecryptedItem[]> {
		// Check cache for each item
		const uncachedItems: DecryptItemRequest[] = [];
		const cachedResults: DecryptedItem[] = [];

		for (const item of items) {
			const cached = this.decryptedItemsCache.get(item.id);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				cachedResults.push(cached.data);
			} else {
				uncachedItems.push(item);
			}
		}

		if (uncachedItems.length === 0) {
			console.log(
				"[desktop-client] All items found in cache:",
				cachedResults.length,
			);
			return cachedResults;
		}

		console.log(
			"[desktop-client] Decrypting",
			uncachedItems.length,
			"items via desktop",
		);

		try {
			const response = await fetch(
				`${DESKTOP_BASE_URL}/native-bridge/decrypt-items`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						email,
						items: uncachedItems,
					}),
					signal: AbortSignal.timeout(10000), // 10 second timeout for decryption
				},
			);

			if (!response.ok) {
				console.error(
					"[desktop-client] Failed to decrypt items:",
					response.status,
				);
				throw new Error(`Desktop decryption failed: ${response.status}`);
			}

			const result = (await response.json()) as DecryptItemsResponse;

			// Cache successful decryptions
			for (const item of result.decrypted_items) {
				this.decryptedItemsCache.set(item.id, {
					data: item,
					timestamp: Date.now(),
				});
			}

			// Log failures
			if (result.failed.length > 0) {
				console.warn(
					"[desktop-client] Failed to decrypt",
					result.failed.length,
					"items:",
					result.failed,
				);
			}

			console.log(
				"[desktop-client] Successfully decrypted",
				result.decrypted_items.length,
				"items",
			);

			// Combine cached and newly decrypted items
			return [...cachedResults, ...result.decrypted_items];
		} catch (error) {
			console.error("[desktop-client] Error decrypting items:", error);
			throw error;
		}
	}

	/**
	 * Clear all caches (called on lock/unlock/disconnect)
	 */
	clearCache(): void {
		console.log("[desktop-client] Clearing all caches");
		this.sessionDataCache = null;
		this.vaultKeysCache.clear();
		this.decryptedItemsCache.clear();
	}

	/**
	 * Clear cache for a specific account
	 */
	clearAccountCache(email: string): void {
		console.log("[desktop-client] Clearing cache for", email);
		this.vaultKeysCache.delete(email.toLowerCase());

		// Note: We don't clear sessionDataCache as it contains all accounts
		// and will be refreshed on next request
	}

	/**
	 * Get JWT token for a specific account from session data
	 */
	async getAuthToken(email: string): Promise<string | null> {
		const sessionData = await this.getSessionData();
		if (!sessionData) return null;

		const account = sessionData.accounts.find(
			(a) => a.email.toLowerCase() === email.toLowerCase(),
		);
		return account?.auth_token ?? null;
	}

	/**
	 * Get account list from desktop (works even when locked)
	 */
	async getAccounts(): Promise<{
		accounts: Array<{
			email: string;
			userId: string;
			name: string;
			secretKeyHint: string;
			teamName?: string;
			lastActiveAt?: number;
			biometricEnabled?: boolean;
			addedAt?: number;
		}>;
		active_account: string | null;
		unlocked_accounts: string[];
	} | null> {
		try {
			const response = await fetch(
				`${DESKTOP_BASE_URL}/native-bridge/accounts`,
				{
					method: "GET",
					signal: AbortSignal.timeout(5000),
				},
			);

			if (!response.ok) {
				console.error(
					"[desktop-client] Failed to fetch accounts:",
					response.status,
				);
				return null;
			}

			const data = await response.json();
			console.log(
				"[desktop-client] Fetched accounts from desktop:",
				data.accounts?.length ?? 0,
			);
			return data;
		} catch (error) {
			console.error("[desktop-client] Error fetching accounts:", error);
			return null;
		}
	}
}

// Export singleton instance
export const desktopClient = new DesktopClient();
