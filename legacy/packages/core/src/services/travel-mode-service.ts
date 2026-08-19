import type { TravelModeConfig, VaultKeyData } from "@bittery/storage/types";

export interface TravelModeServerResponse {
	enabled: boolean;
	hiddenVaultIds: readonly string[];
	enabledAt?: string | null;
	updatedAt: string;
}

export interface TravelModeApiClient {
	travelMode: {
		get: () => Promise<{ data: TravelModeServerResponse }>;
		setHiddenVaults: (input: {
			hiddenVaultIds: string[];
		}) => Promise<{ data: TravelModeServerResponse }>;
		enable: (input: {
			hiddenVaultIds: string[];
		}) => Promise<{ data: TravelModeServerResponse }>;
		disable: (input: {
			attemptId: string;
			clientPublicKey: string;
			clientProof: string;
		}) => Promise<{ data: TravelModeServerResponse }>;
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

export function mapTravelModeResponse(
	response: TravelModeServerResponse,
): TravelModeConfig {
	return {
		enabled: response.enabled,
		hiddenVaultIds: [...response.hiddenVaultIds],
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
