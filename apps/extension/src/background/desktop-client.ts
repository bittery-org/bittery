/**
 * Desktop Client Service
 * Handles authenticated communication with the desktop bridge.
 */

import { sendNativeMessage } from "./native-messaging-client";

const DESKTOP_BASE_URL = "http://localhost:48765";
const CACHE_TTL_MS = 5000;

export interface BridgeAuth {
	bridgeToken: string;
	allowedOrigin: string;
	bridgeVersion?: string;
}

export interface DesktopStatus {
	available: boolean;
	locked: boolean;
	unlockedAccounts: string[];
	timestamp: number;
	autolockTimeoutMs: number;
}

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
	vault_keys: string;
}

interface DecryptItemRequest {
	id: string;
	vaultId: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	version?: number;
	userId?: string;
}

interface DecryptedItem {
	id: string;
	decrypted_data: string;
}

interface DecryptItemsResponse {
	decrypted_items: DecryptedItem[];
	failed: Array<{ id: string; error: string }>;
}

interface CachedData<T> {
	data: T;
	timestamp: number;
}

type FetchLike = typeof fetch;

type DesktopClientDeps = {
	fetchImpl?: FetchLike;
	loadBridgeAuth?: () => Promise<BridgeAuth>;
};

async function defaultLoadBridgeAuth(): Promise<BridgeAuth> {
	const response = (await sendNativeMessage({
		type: "GET_BRIDGE_AUTH",
		extension_id: chrome.runtime.id,
	})) as {
		type?: string;
		bridge_token?: string;
		allowed_origin?: string;
		bridge_version?: string;
		message?: string;
	};

	if (response?.type !== "BRIDGE_AUTH") {
		throw new Error(response?.message || "Failed to load desktop bridge auth");
	}

	if (!response.bridge_token || !response.allowed_origin) {
		throw new Error("Desktop bridge auth response was incomplete");
	}

	return {
		bridgeToken: response.bridge_token,
		allowedOrigin: response.allowed_origin,
		bridgeVersion: response.bridge_version,
	};
}

export class DesktopClient {
	private readonly fetchImpl: FetchLike;
	private readonly loadBridgeAuthImpl: () => Promise<BridgeAuth>;
	private bridgeAuthCache: BridgeAuth | null = null;
	private sessionDataCache: CachedData<SessionDataResponse> | null = null;
	private vaultKeysCache = new Map<string, CachedData<VaultKeysResponse>>();
	private decryptedItemsCache = new Map<string, CachedData<DecryptedItem>>();

	constructor(deps: DesktopClientDeps = {}) {
		this.fetchImpl =
			deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		this.loadBridgeAuthImpl = deps.loadBridgeAuth ?? defaultLoadBridgeAuth;
	}

	private async getBridgeAuth(forceRefresh = false): Promise<BridgeAuth> {
		if (!forceRefresh && this.bridgeAuthCache) {
			return this.bridgeAuthCache;
		}

		const bridgeAuth = await this.loadBridgeAuthImpl();
		this.bridgeAuthCache = bridgeAuth;
		return bridgeAuth;
	}

	async fetchBridge(
		path: string,
		init: RequestInit = {},
		options: { retryOnUnauthorized?: boolean } = {},
	): Promise<Response> {
		const retryOnUnauthorized = options.retryOnUnauthorized ?? true;
		const bridgeAuth = await this.getBridgeAuth(false);
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${bridgeAuth.bridgeToken}`);

		const response = await this.fetchImpl(`${DESKTOP_BASE_URL}${path}`, {
			...init,
			headers,
		});

		if (response.status === 401 && retryOnUnauthorized) {
			this.clearBridgeAuth();
			const refreshedAuth = await this.getBridgeAuth(true);
			const retryHeaders = new Headers(init.headers);
			retryHeaders.set("Authorization", `Bearer ${refreshedAuth.bridgeToken}`);
			const retryResponse = await this.fetchImpl(`${DESKTOP_BASE_URL}${path}`, {
				...init,
				headers: retryHeaders,
			});
			return retryResponse;
		}

		return response;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const response = await this.fetchBridge("/native-bridge/lock-status", {
				method: "GET",
				signal: AbortSignal.timeout(2000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async getLockStatus(): Promise<DesktopStatus | null> {
		try {
			const response = await this.fetchBridge("/native-bridge/lock-status", {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				return null;
			}

			const data = (await response.json()) as {
				locked?: boolean;
				unlocked_accounts?: string[];
				timestamp?: number;
				autolock_timeout_ms?: number;
			};

			return {
				available: true,
				locked: data.locked ?? true,
				unlockedAccounts: data.unlocked_accounts ?? [],
				timestamp: data.timestamp ?? Date.now(),
				autolockTimeoutMs: data.autolock_timeout_ms ?? -1,
			};
		} catch {
			return null;
		}
	}

	async getSessionData(): Promise<SessionDataResponse | null> {
		if (this.sessionDataCache) {
			const age = Date.now() - this.sessionDataCache.timestamp;
			if (age < CACHE_TTL_MS) {
				return this.sessionDataCache.data;
			}
		}

		try {
			const response = await this.fetchBridge("/native-bridge/session-data", {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				return null;
			}

			const data = (await response.json()) as SessionDataResponse;
			this.sessionDataCache = { data, timestamp: Date.now() };
			return data;
		} catch {
			return null;
		}
	}

	async getVaultKeys(email: string): Promise<VaultKeysResponse | null> {
		const cacheKey = email.toLowerCase();
		const cached = this.vaultKeysCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
			return cached.data;
		}

		try {
			const response = await this.fetchBridge(
				`/native-bridge/vault-keys?email=${encodeURIComponent(email)}`,
				{
					method: "GET",
					signal: AbortSignal.timeout(5000),
				},
			);

			if (!response.ok) {
				return null;
			}

			const data = (await response.json()) as VaultKeysResponse;
			this.vaultKeysCache.set(cacheKey, {
				data,
				timestamp: Date.now(),
			});
			return data;
		} catch {
			return null;
		}
	}

	async decryptItems(
		email: string,
		items: DecryptItemRequest[],
	): Promise<DecryptedItem[]> {
		const uncachedItems: DecryptItemRequest[] = [];
		const cachedResults: DecryptedItem[] = [];

		for (const item of items) {
			const cached = this.decryptedItemsCache.get(item.id);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				cachedResults.push(cached.data);
				continue;
			}
			uncachedItems.push(item);
		}

		if (uncachedItems.length === 0) {
			return cachedResults;
		}

		const response = await this.fetchBridge("/native-bridge/decrypt-items", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				email,
				items: uncachedItems,
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) {
			throw new Error(`Desktop decryption failed: ${response.status}`);
		}

		const result = (await response.json()) as DecryptItemsResponse;

		for (const item of result.decrypted_items) {
			this.decryptedItemsCache.set(item.id, {
				data: item,
				timestamp: Date.now(),
			});
		}

		return [...cachedResults, ...result.decrypted_items];
	}

	clearCache(): void {
		this.sessionDataCache = null;
		this.vaultKeysCache.clear();
		this.decryptedItemsCache.clear();
	}

	clearAccountCache(email: string): void {
		this.vaultKeysCache.delete(email.toLowerCase());
	}

	clearBridgeAuth(): void {
		this.bridgeAuthCache = null;
	}

	async getAuthToken(email: string): Promise<string | null> {
		const sessionData = await this.getSessionData();
		if (!sessionData) {
			return null;
		}

		const account = sessionData.accounts.find(
			(entry) => entry.email.toLowerCase() === email.toLowerCase(),
		);
		return account?.auth_token ?? null;
	}

	async getAccounts(): Promise<{
		accounts: Array<{
			email: string;
			userId: string;
			name: string;
			secretKeyHint: string;
			teamName?: string;
			teamAvatarUrl?: string | null;
			lastActiveAt?: number;
			biometricEnabled?: boolean;
			addedAt?: number;
		}>;
		active_account: string | null;
		unlocked_accounts: string[];
	} | null> {
		try {
			const response = await this.fetchBridge("/native-bridge/accounts", {
				method: "GET",
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				return null;
			}

			return (await response.json()) as {
				accounts: Array<{
					email: string;
					userId: string;
					name: string;
					secretKeyHint: string;
					teamName?: string;
					teamAvatarUrl?: string | null;
					lastActiveAt?: number;
					biometricEnabled?: boolean;
					addedAt?: number;
				}>;
				active_account: string | null;
				unlocked_accounts: string[];
			};
		} catch {
			return null;
		}
	}
}

export const desktopClient = new DesktopClient();
