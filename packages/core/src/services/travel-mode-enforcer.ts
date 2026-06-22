/**
 * TravelModeEnforcer — single enforcement point for travel mode per account.
 * Owns config, purge, and read-filtering keyed by accountId.
 */

import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { TravelModeConfig, VaultKeyData } from "@bittery/storage/types";
import {
	filterItemsByTravelMode,
	filterVaultKeys,
	isVaultHidden,
	mapTravelModeResponse,
	type TravelModeDisableProof,
	type TravelModeRpcClient,
	type TravelModeServerResponse,
} from "./travel-mode-service";
import type { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

export interface TravelModeEnforcerOptions {
	storage: IStorageAdapter;
	coordinator?: VaultRepositoryCoordinator;
}

const DEFAULT_CONFIG: TravelModeConfig = {
	enabled: false,
	hiddenVaultIds: [],
};

export class TravelModeEnforcer {
	private readonly memoryCache = new Map<string, TravelModeConfig>();

	constructor(private options: TravelModeEnforcerOptions) {}

	setCoordinator(coordinator: VaultRepositoryCoordinator): void {
		this.options = { ...this.options, coordinator };
	}

	get storage(): IStorageAdapter {
		return this.options.storage;
	}

	getConfig(accountId: string): TravelModeConfig {
		return this.memoryCache.get(accountId) ?? { ...DEFAULT_CONFIG };
	}

	isEnabled(accountId: string): boolean {
		return this.getConfig(accountId).enabled;
	}

	isVaultHidden(accountId: string, vaultId: string): boolean {
		return isVaultHidden(this.getConfig(accountId), vaultId);
	}

	filterVaultKeys<T extends VaultKeyData>(
		accountId: string,
		vaultKeys: T[],
	): T[] {
		return filterVaultKeys(vaultKeys, this.getConfig(accountId));
	}

	filterItems<T extends { vaultId: string }>(
		accountId: string,
		items: T[],
	): T[] {
		return filterItemsByTravelMode(items, this.getConfig(accountId));
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

	/**
	 * Single apply path: persist config, purge storage, and purge in-memory repos.
	 */
	async applyConfig(
		accountId: string,
		config: TravelModeConfig,
	): Promise<void> {
		const previous = this.getConfig(accountId);
		await this.persistConfig(accountId, config);

		if (config.enabled) {
			await this.purgeAllLayers(accountId, config.hiddenVaultIds);
			return;
		}

		if (previous.enabled) {
			// Disabled — caller should trigger server refetch via restoreAfterDisable
		}
	}

	async purgeAllLayers(
		accountId: string,
		hiddenVaultIds: string[],
	): Promise<void> {
		if (hiddenVaultIds.length === 0) {
			return;
		}

		const hidden = new Set(hiddenVaultIds);

		// Storage layer
		const vaultKeys = await this.storage.getVaultKeys(accountId);
		if (vaultKeys) {
			const filtered = vaultKeys.filter((k) => !hidden.has(k.vaultId));
			await this.storage.storeVaultKeys(filtered, accountId);
		}

		const cachedItems = await this.storage.getCachedItems?.(accountId);
		if (cachedItems) {
			const filtered = cachedItems.filter((i) => !hidden.has(i.vaultId));
			await this.storage.setCachedItems?.(filtered, accountId);
		}

		const cachedVaults = await this.storage.getCachedVaults?.(accountId);
		if (cachedVaults) {
			const filtered = cachedVaults.filter((v) => !hidden.has(v.id));
			await this.storage.setCachedVaults?.(filtered, accountId);
		}

		// In-memory repo layer via coordinator
		this.options.coordinator?.purgeHiddenVaultsForAccount(
			accountId,
			hiddenVaultIds,
		);
	}

	async fetchFromServer(
		accountId: string,
		rpcClient: TravelModeRpcClient,
	): Promise<TravelModeConfig> {
		const response = await rpcClient.travelMode.getTravelMode.query();
		const config = mapTravelModeResponse(response);
		await this.applyConfig(accountId, config);
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
		await this.applyConfig(accountId, config);
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
		await this.applyConfig(accountId, config);
		return config;
	}

	async applySyncEventMetadata(
		accountId: string,
		metadata: Record<string, unknown> | undefined,
	): Promise<TravelModeConfig> {
		if (!metadata) {
			return this.getConfig(accountId);
		}

		const enabled =
			typeof metadata.enabled === "boolean"
				? metadata.enabled
				: this.getConfig(accountId).enabled;
		const hiddenVaultIds = Array.isArray(metadata.hiddenVaultIds)
			? metadata.hiddenVaultIds.filter(
					(v): v is string => typeof v === "string",
				)
			: this.getConfig(accountId).hiddenVaultIds;

		const config: TravelModeConfig = {
			enabled,
			hiddenVaultIds,
			enabledAt: enabled ? Date.now() : null,
			updatedAt: Date.now(),
		};

		await this.applyConfig(accountId, config);
		return config;
	}

	async stripVaultKeysIfActive(
		accountId: string,
		vaultKeys: VaultKeyData[],
	): Promise<VaultKeyData[]> {
		const filtered = this.filterVaultKeys(accountId, vaultKeys);
		if (filtered.length !== vaultKeys.length) {
			await this.storage.storeVaultKeys(filtered, accountId);
		}
		return filtered;
	}

	async handleSyncEvent(
		event: { type: string; metadata?: Record<string, unknown> },
		accountId: string,
		restoreCallback?: () => Promise<void>,
	): Promise<void> {
		if (event.type !== "travel_mode_updated") {
			return;
		}

		const previous = this.getConfig(accountId);
		const config = await this.applySyncEventMetadata(accountId, event.metadata);

		if (!config.enabled && previous.enabled && restoreCallback) {
			await restoreCallback();
		}
	}
}

let enforcerByStorage = new WeakMap<IStorageAdapter, TravelModeEnforcer>();

export function getTravelModeEnforcer(
	storage: IStorageAdapter,
	coordinator?: VaultRepositoryCoordinator,
): TravelModeEnforcer {
	const existing = enforcerByStorage.get(storage);
	if (existing) {
		if (coordinator) {
			existing.setCoordinator(coordinator);
		}
		return existing;
	}
	const created = new TravelModeEnforcer({ storage, coordinator });
	enforcerByStorage.set(storage, created);
	return created;
}

export function resetTravelModeEnforcerForTests(): void {
	enforcerByStorage = new WeakMap();
}

export type { TravelModeServerResponse };
