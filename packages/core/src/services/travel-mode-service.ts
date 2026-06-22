import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { TravelModeConfig, VaultKeyData } from "@bittery/storage/types";

export interface TravelModeServerResponse {
	enabled: boolean;
	hiddenVaultIds: string[];
	enabledAt: string | null;
	updatedAt: string;
}

export interface TravelModeRpcClient {
	travelMode: {
		getTravelMode: {
			query: () => Promise<TravelModeServerResponse>;
		};
		setTravelModeHiddenVaults: {
			mutate: (input: {
				hiddenVaultIds: string[];
			}) => Promise<TravelModeServerResponse>;
		};
		enableTravelMode: {
			mutate: (input: {
				hiddenVaultIds: string[];
			}) => Promise<TravelModeServerResponse>;
		};
		disableTravelMode: {
			mutate: (input: {
				attemptId: string;
				clientPublicKey: string;
				clientProof: string;
			}) => Promise<TravelModeServerResponse>;
		};
	};
}

export interface TravelModeDisableProof {
	attemptId: string;
	clientPublicKey: string;
	clientProof: string;
}

export interface TravelModeItem {
	vaultId: string;
}

const DEFAULT_CONFIG: TravelModeConfig = {
	enabled: false,
	hiddenVaultIds: [],
};

function normalizeEmail(email: string): string {
	return email.toLowerCase();
}

export function mapTravelModeResponse(
	response: TravelModeServerResponse,
): TravelModeConfig {
	return {
		enabled: response.enabled,
		hiddenVaultIds: response.hiddenVaultIds,
		enabledAt: response.enabledAt ? Date.parse(response.enabledAt) : null,
		updatedAt: Date.parse(response.updatedAt),
	};
}

export function isVaultHidden(
	config: TravelModeConfig | null | undefined,
	vaultId: string,
): boolean {
	if (!config?.enabled) {
		return false;
	}
	return config.hiddenVaultIds.includes(vaultId);
}

export function filterVaultKeys<T extends VaultKeyData>(
	vaultKeys: T[],
	config: TravelModeConfig | null | undefined,
): T[] {
	if (!config?.enabled) {
		return vaultKeys;
	}
	const hidden = new Set(config.hiddenVaultIds);
	return vaultKeys.filter((vaultKey) => !hidden.has(vaultKey.vaultId));
}

export function filterItemsByTravelMode<T extends TravelModeItem>(
	items: T[],
	config: TravelModeConfig | null | undefined,
): T[] {
	if (!config?.enabled) {
		return items;
	}
	const hidden = new Set(config.hiddenVaultIds);
	return items.filter((item) => !hidden.has(item.vaultId));
}

export function shouldCacheVaultForTravelMode(
	vaultId: string,
	config: TravelModeConfig | null | undefined,
): boolean {
	return !isVaultHidden(config, vaultId);
}

export class TravelModeService {
	private readonly memoryCache = new Map<string, TravelModeConfig>();

	constructor(private readonly storage: IStorageAdapter) {}

	private cacheKey(email: string): string {
		return normalizeEmail(email);
	}

	getConfig(email: string): TravelModeConfig {
		return (
			this.memoryCache.get(this.cacheKey(email)) ?? {
				...DEFAULT_CONFIG,
			}
		);
	}

	isEnabled(email: string): boolean {
		return this.getConfig(email).enabled;
	}

	async hydrateFromStorage(email: string): Promise<TravelModeConfig> {
		const cached = (await this.storage.getTravelModeCache?.(email)) ?? null;
		const config = cached ?? DEFAULT_CONFIG;
		this.memoryCache.set(this.cacheKey(email), config);
		return config;
	}

	private async persistConfig(
		email: string,
		config: TravelModeConfig,
	): Promise<void> {
		this.memoryCache.set(this.cacheKey(email), config);
		await this.storage.storeTravelModeCache?.(config, email);
	}

	async fetchFromServer(
		email: string,
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.getTravelMode.query();
		const config = mapTravelModeResponse(response);
		await this.persistConfig(email, config);
		if (config.enabled) {
			await this.purgeHiddenVaultData(email, config.hiddenVaultIds);
		}
		return config;
	}

	async setHiddenVaults(
		email: string,
		hiddenVaultIds: string[],
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response =
			await rpcClient.travelMode.setTravelModeHiddenVaults.mutate({
				hiddenVaultIds,
			});
		const config = mapTravelModeResponse(response);
		await this.persistConfig(email, config);
		return config;
	}

	async enable(
		email: string,
		hiddenVaultIds: string[],
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.enableTravelMode.mutate({
			hiddenVaultIds,
		});
		const config = mapTravelModeResponse(response);
		await this.persistConfig(email, config);
		await this.purgeHiddenVaultData(email, config.hiddenVaultIds);
		return config;
	}

	async disable(
		email: string,
		rpcClient: TravelModeRpcClient,
		proof: TravelModeDisableProof,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.disableTravelMode.mutate({
			attemptId: proof.attemptId,
			clientPublicKey: proof.clientPublicKey,
			clientProof: proof.clientProof,
		});
		const config = mapTravelModeResponse(response);
		await this.persistConfig(email, config);
		return config;
	}

	async applyRemoteUpdate(
		email: string,
		config: TravelModeConfig,
	): Promise<void> {
		await this.persistConfig(email, config);
		if (config.enabled) {
			await this.purgeHiddenVaultData(email, config.hiddenVaultIds);
		}
	}

	async applySyncEventMetadata(
		email: string,
		metadata: Record<string, unknown> | undefined,
	): Promise<void> {
		if (!metadata) {
			return;
		}

		const enabled = Boolean(metadata.enabled);
		const hiddenVaultIds = Array.isArray(metadata.hiddenVaultIds)
			? metadata.hiddenVaultIds.filter(
					(value): value is string => typeof value === "string",
				)
			: this.getConfig(email).hiddenVaultIds;

		await this.applyRemoteUpdate(email, {
			enabled,
			hiddenVaultIds,
			enabledAt: enabled ? Date.now() : null,
			updatedAt: Date.now(),
		});
	}

	filterVaultKeys<T extends VaultKeyData>(email: string, vaultKeys: T[]): T[] {
		return filterVaultKeys(vaultKeys, this.getConfig(email));
	}

	filterItems<T extends TravelModeItem>(email: string, items: T[]): T[] {
		return filterItemsByTravelMode(items, this.getConfig(email));
	}

	shouldCacheVault(email: string, vaultId: string): boolean {
		return shouldCacheVaultForTravelMode(vaultId, this.getConfig(email));
	}

	async purgeHiddenVaultData(
		email: string,
		hiddenVaultIds: string[],
	): Promise<void> {
		if (hiddenVaultIds.length === 0) {
			return;
		}

		const hidden = new Set(hiddenVaultIds);
		const vaultKeys = await this.storage.getVaultKeys(email);
		if (vaultKeys) {
			const filtered = vaultKeys.filter(
				(vaultKey) => !hidden.has(vaultKey.vaultId),
			);
			await this.storage.storeVaultKeys(filtered, email);
		}

		const cachedItems = await this.storage.getCachedItems?.(email);
		if (cachedItems) {
			const filteredItems = cachedItems.filter(
				(item) => !hidden.has(item.vaultId),
			);
			await this.storage.setCachedItems?.(filteredItems, email);
		}

		const cachedVaults = await this.storage.getCachedVaults?.(email);
		if (cachedVaults) {
			const filteredVaults = cachedVaults.filter(
				(vault) => !hidden.has(vault.id),
			);
			await this.storage.setCachedVaults?.(filteredVaults, email);
		}
	}

	async stripVaultKeysIfActive(
		email: string,
		vaultKeys: VaultKeyData[],
	): Promise<VaultKeyData[]> {
		const config = this.getConfig(email);
		const filtered = filterVaultKeys(vaultKeys, config);
		if (filtered.length !== vaultKeys.length) {
			await this.storage.storeVaultKeys(filtered, email);
		}
		return filtered;
	}
}

let sharedTravelModeService: TravelModeService | null = null;

export function getTravelModeService(
	storage: IStorageAdapter,
): TravelModeService {
	if (!sharedTravelModeService) {
		sharedTravelModeService = new TravelModeService(storage);
	}
	return sharedTravelModeService;
}

export function resetTravelModeServiceForTests(): void {
	sharedTravelModeService = null;
}
