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

	getConfig(accountId: string): TravelModeConfig {
		return (
			this.memoryCache.get(accountId) ?? {
				...DEFAULT_CONFIG,
			}
		);
	}

	isEnabled(accountId: string): boolean {
		return this.getConfig(accountId).enabled;
	}

	async hydrateFromStorage(accountId: string): Promise<TravelModeConfig> {
		const cached = (await this.storage.getTravelModeCache?.(accountId)) ?? null;
		const config = cached ?? DEFAULT_CONFIG;
		this.memoryCache.set(accountId, config);
		return config;
	}

	private async persistConfig(
		accountId: string,
		config: TravelModeConfig,
	): Promise<void> {
		this.memoryCache.set(accountId, config);
		await this.storage.storeTravelModeCache?.(config, accountId);
	}

	async fetchFromServer(
		accountId: string,
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.getTravelMode.query();
		const config = mapTravelModeResponse(response);
		await this.persistConfig(accountId, config);
		if (config.enabled) {
			await this.purgeHiddenVaultData(accountId, config.hiddenVaultIds);
		}
		return config;
	}

	async setHiddenVaults(
		accountId: string,
		hiddenVaultIds: string[],
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response =
			await rpcClient.travelMode.setTravelModeHiddenVaults.mutate({
				hiddenVaultIds,
			});
		const config = mapTravelModeResponse(response);
		await this.persistConfig(accountId, config);
		return config;
	}

	async enable(
		accountId: string,
		hiddenVaultIds: string[],
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.enableTravelMode.mutate({
			hiddenVaultIds,
		});
		const config = mapTravelModeResponse(response);
		await this.persistConfig(accountId, config);
		await this.purgeHiddenVaultData(accountId, config.hiddenVaultIds);
		return config;
	}

	async disable(
		accountId: string,
		rpcClient: TravelModeRpcClient,
		proof: TravelModeDisableProof,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.disableTravelMode.mutate({
			attemptId: proof.attemptId,
			clientPublicKey: proof.clientPublicKey,
			clientProof: proof.clientProof,
		});
		const config = mapTravelModeResponse(response);
		await this.persistConfig(accountId, config);
		return config;
	}

	async applyRemoteUpdate(
		accountId: string,
		config: TravelModeConfig,
	): Promise<void> {
		await this.persistConfig(accountId, config);
		if (config.enabled) {
			await this.purgeHiddenVaultData(accountId, config.hiddenVaultIds);
		}
	}

	async applySyncEventMetadata(
		accountId: string,
		metadata: Record<string, unknown> | undefined,
	): Promise<void> {
		if (!metadata) {
			return;
		}

		const enabled =
			typeof metadata.enabled === "boolean"
				? metadata.enabled
				: this.getConfig(accountId).enabled;
		const hiddenVaultIds =
			Array.isArray(metadata.hiddenVaultIds) &&
			metadata.hiddenVaultIds.every(
				(value): value is string => typeof value === "string",
			)
				? metadata.hiddenVaultIds
				: this.getConfig(accountId).hiddenVaultIds;

		await this.applyRemoteUpdate(accountId, {
			enabled,
			hiddenVaultIds,
			enabledAt: enabled ? Date.now() : null,
			updatedAt: Date.now(),
		});
	}

	filterVaultKeys<T extends VaultKeyData>(
		accountId: string,
		vaultKeys: T[],
	): T[] {
		return filterVaultKeys(vaultKeys, this.getConfig(accountId));
	}

	filterItems<T extends TravelModeItem>(accountId: string, items: T[]): T[] {
		return filterItemsByTravelMode(items, this.getConfig(accountId));
	}

	shouldCacheVault(accountId: string, vaultId: string): boolean {
		return shouldCacheVaultForTravelMode(vaultId, this.getConfig(accountId));
	}

	async purgeHiddenVaultData(
		accountId: string,
		hiddenVaultIds: string[],
	): Promise<void> {
		if (hiddenVaultIds.length === 0) {
			return;
		}

		const hidden = new Set(hiddenVaultIds);
		const vaultKeys = await this.storage.getVaultKeys(accountId);
		if (vaultKeys) {
			const filtered = vaultKeys.filter(
				(vaultKey) => !hidden.has(vaultKey.vaultId),
			);
			await this.storage.storeVaultKeys(filtered, accountId);
		}

		const cachedItems = await this.storage.getCachedItems?.(accountId);
		if (cachedItems) {
			const filteredItems = cachedItems.filter(
				(item) => !hidden.has(item.vaultId),
			);
			await this.storage.setCachedItems?.(filteredItems, accountId);
		}

		const cachedVaults = await this.storage.getCachedVaults?.(accountId);
		if (cachedVaults) {
			const filteredVaults = cachedVaults.filter(
				(vault) => !hidden.has(vault.id),
			);
			await this.storage.setCachedVaults?.(filteredVaults, accountId);
		}
	}

	async stripVaultKeysIfActive(
		accountId: string,
		vaultKeys: VaultKeyData[],
	): Promise<VaultKeyData[]> {
		const config = this.getConfig(accountId);
		const filtered = filterVaultKeys(vaultKeys, config);
		if (filtered.length !== vaultKeys.length) {
			await this.storage.storeVaultKeys(filtered, accountId);
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
