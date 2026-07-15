import type { DesktopEventPayload, DesktopResponse } from "./desktop-protocol";
import {
	type NativeMessagingClient,
	nativeMessagingClient,
} from "./native-messaging-client";

const CACHE_TTL_MS = 5000;

export interface DesktopStatus {
	available: boolean;
	locked: boolean;
	unlockedAccounts: string[];
	timestamp: number;
	autolockTimeoutMs: number;
}

interface CachedData<T> {
	data: T;
	timestamp: number;
}

type DesktopAccountsResponse = Extract<
	DesktopResponse,
	{ type: "DESKTOP_ACCOUNTS" }
>;
type DesktopVaultKeysResponse = Extract<
	DesktopResponse,
	{ type: "DESKTOP_VAULT_KEYS" }
>;
type DesktopItemsSnapshotResponse = Extract<
	DesktopResponse,
	{ type: "DESKTOP_ITEMS_SNAPSHOT" }
>;

type DesktopClientDeps = {
	nativeClient?: Pick<
		NativeMessagingClient,
		"request" | "subscribeToDesktopEvents"
	>;
};

export class DesktopClient {
	private readonly nativeClient: Pick<
		NativeMessagingClient,
		"request" | "subscribeToDesktopEvents"
	>;
	private accountsCache: CachedData<DesktopAccountsResponse> | null = null;
	private vaultKeysCache = new Map<
		string,
		CachedData<DesktopVaultKeysResponse>
	>();
	private authTokenCache = new Map<
		string,
		CachedData<{
			accountId: string;
			email: string;
			authToken: string;
			expiresAt?: number;
			userId?: string;
		}>
	>();
	private itemsSnapshotCache = new Map<
		string,
		CachedData<DesktopItemsSnapshotResponse>
	>();

	constructor(deps: DesktopClientDeps = {}) {
		this.nativeClient = deps.nativeClient ?? nativeMessagingClient;
	}

	private isFresh(timestamp: number): boolean {
		return Date.now() - timestamp < CACHE_TTL_MS;
	}

	async isAvailable(): Promise<boolean> {
		const status = await this.getLockStatus();
		return !!status?.available;
	}

	async getLockStatus(): Promise<DesktopStatus | null> {
		try {
			const response = await this.nativeClient.request({
				type: "GET_DESKTOP_STATUS",
			});
			if (response.type !== "DESKTOP_STATUS") {
				return null;
			}

			return {
				available: response.available,
				locked: response.locked,
				unlockedAccounts: response.unlockedAccounts ?? [],
				timestamp: response.timestamp ?? Date.now(),
				autolockTimeoutMs: response.autolockTimeoutMs ?? -1,
			};
		} catch {
			return null;
		}
	}

	async getAccounts(): Promise<DesktopAccountsResponse | null> {
		if (this.accountsCache && this.isFresh(this.accountsCache.timestamp)) {
			return this.accountsCache.data;
		}

		try {
			const response = await this.nativeClient.request({
				type: "GET_DESKTOP_ACCOUNTS",
			});
			if (response.type !== "DESKTOP_ACCOUNTS") {
				return null;
			}

			this.accountsCache = {
				data: response,
				timestamp: Date.now(),
			};
			return response;
		} catch {
			return null;
		}
	}

	async getAuthToken(accountId: string): Promise<string | null> {
		const cacheKey = accountId;
		const cached = this.authTokenCache.get(cacheKey);
		if (cached && this.isFresh(cached.timestamp)) {
			return cached.data.authToken;
		}

		try {
			const response = await this.nativeClient.request({
				type: "GET_DESKTOP_AUTH_TOKEN",
				accountId,
			});
			if (response.type !== "DESKTOP_AUTH_TOKEN") {
				return null;
			}

			this.authTokenCache.set(cacheKey, {
				data: response,
				timestamp: Date.now(),
			});
			return response.authToken;
		} catch {
			return null;
		}
	}

	async getVaultKeys(
		accountId: string,
	): Promise<DesktopVaultKeysResponse | null> {
		const cacheKey = accountId;
		const cached = this.vaultKeysCache.get(cacheKey);
		if (cached && this.isFresh(cached.timestamp)) {
			return cached.data;
		}

		try {
			const response = await this.nativeClient.request({
				type: "GET_DESKTOP_VAULT_KEYS",
				accountId,
			});
			if (response.type !== "DESKTOP_VAULT_KEYS") {
				return null;
			}

			this.vaultKeysCache.set(cacheKey, {
				data: response,
				timestamp: Date.now(),
			});
			return response;
		} catch {
			return null;
		}
	}

	async getItemsSnapshot(
		accountIds?: string[],
	): Promise<DesktopItemsSnapshotResponse | null> {
		const normalizedAccountIds = accountIds
			?.slice()
			.sort((left, right) => left.localeCompare(right));
		const cacheKey = normalizedAccountIds?.join(",") ?? "__all__";
		const cached = this.itemsSnapshotCache.get(cacheKey);
		if (cached && this.isFresh(cached.timestamp)) {
			return cached.data;
		}

		try {
			const response = await this.nativeClient.request({
				type: "GET_DESKTOP_ITEMS_SNAPSHOT",
				accountIds: normalizedAccountIds,
			});
			if (response.type === "ERROR") {
				console.warn("[desktop-client] Desktop snapshot request failed", {
					accountIds: normalizedAccountIds,
					message: response.message,
				});
				return null;
			}
			if (response.type !== "DESKTOP_ITEMS_SNAPSHOT") {
				return null;
			}

			this.itemsSnapshotCache.set(cacheKey, {
				data: response,
				timestamp: Date.now(),
			});
			return response;
		} catch {
			return null;
		}
	}

	async triggerDesktopUnlock(): Promise<boolean> {
		try {
			const response = await this.nativeClient.request({
				type: "TRIGGER_DESKTOP_UNLOCK",
			});
			return (
				response.type === "TRIGGER_DESKTOP_UNLOCK_RESULT" && response.success
			);
		} catch {
			return false;
		}
	}

	subscribeToDesktopEvents(
		listener: (event: DesktopEventPayload) => void,
	): () => void {
		return this.nativeClient.subscribeToDesktopEvents(listener);
	}

	clearCache(): void {
		this.accountsCache = null;
		this.vaultKeysCache.clear();
		this.authTokenCache.clear();
		this.itemsSnapshotCache.clear();
	}

	clearAccountCache(accountId: string): void {
		this.vaultKeysCache.delete(accountId);
		this.authTokenCache.delete(accountId);
	}
}

export const desktopClient = new DesktopClient();
