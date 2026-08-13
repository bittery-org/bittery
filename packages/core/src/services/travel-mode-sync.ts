import type { AccountStore, ItemCache } from "@bittery/storage";
import type { AccountResolver } from "./account-resolver";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type { VaultRepository } from "./vault-repository";
import { type ApiVaultClient, refreshVaultKeys } from "./vault-service";

export interface TravelModeSyncEvent {
	type: string;
	metadata?: Record<string, unknown>;
}

export interface TravelModeSyncRestoreOptions {
	apiClient: ApiVaultClient;
	accounts: AccountResolver;
}

export async function restoreAfterTravelModeDisabled(
	accountId: string,
	storage: AccountStore,
	repository: VaultRepository,
	{ apiClient, accounts }: TravelModeSyncRestoreOptions,
): Promise<void> {
	await refreshVaultKeys(apiClient, storage, accountId);

	const vaultKeys = await storage.getVaultKeys(accountId);
	if (vaultKeys) {
		await repository.syncVaultKeys(vaultKeys, accountId);
	}

	const { accountsInfo } = await accounts.resolveAccounts();
	const account = accountsInfo.find(
		(candidate) => candidate.accountId === accountId,
	);
	if (account) {
		await repository.refreshFromServer([account]);
	}
}

export async function handleTravelModeSyncEvent(
	event: TravelModeSyncEvent,
	accountId: string,
	storage: AccountStore,
	itemCache: ItemCache,
	repository?: VaultRepository,
	restoreOptions?: TravelModeSyncRestoreOptions,
): Promise<void> {
	if (event.type !== "travel_mode_updated") {
		return;
	}

	const enforcer = getTravelModeEnforcer(storage, itemCache, repository);
	const previousConfig = enforcer.getConfig(accountId);
	const config = await enforcer.applySyncEventMetadata(
		accountId,
		event.metadata,
	);

	if (config.enabled) {
		return;
	}

	if (previousConfig.enabled && repository && restoreOptions) {
		await restoreAfterTravelModeDisabled(
			accountId,
			storage,
			repository,
			restoreOptions,
		);
	}
}
