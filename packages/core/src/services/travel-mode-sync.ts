import type { AccountStore, ItemCache } from "@bittery/storage";
import type { AccountResolver } from "./account-resolver";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type { VaultRepositoryCoordinator } from "./vault-repository-coordinator";
import { type RpcVaultClient, refreshVaultKeys } from "./vault-service";

export interface TravelModeSyncEvent {
	type: string;
	metadata?: Record<string, unknown>;
}

export interface TravelModeSyncRestoreOptions {
	rpcClient: RpcVaultClient;
	accounts: AccountResolver;
}

export async function restoreAfterTravelModeDisabled(
	accountId: string,
	storage: AccountStore,
	coordinator: VaultRepositoryCoordinator,
	{ rpcClient, accounts }: TravelModeSyncRestoreOptions,
): Promise<void> {
	await refreshVaultKeys(rpcClient, storage, accountId);

	const vaultKeys = await storage.getVaultKeys(accountId);
	if (vaultKeys) {
		await coordinator.syncVaultKeys(vaultKeys, accountId);
	}

	const { accountsInfo } = await accounts.resolveAccounts();
	const account = accountsInfo.find(
		(candidate) => candidate.accountId === accountId,
	);
	if (account) {
		await coordinator.refreshFromServer([account]);
	}
}

export async function handleTravelModeSyncEvent(
	event: TravelModeSyncEvent,
	accountId: string,
	storage: AccountStore,
	itemCache: ItemCache,
	coordinator?: VaultRepositoryCoordinator,
	restoreOptions?: TravelModeSyncRestoreOptions,
): Promise<void> {
	if (event.type !== "travel_mode_updated") {
		return;
	}

	const enforcer = getTravelModeEnforcer(storage, itemCache, coordinator);
	const previousConfig = enforcer.getConfig(accountId);
	const config = await enforcer.applySyncEventMetadata(
		accountId,
		event.metadata,
	);

	if (config.enabled) {
		return;
	}

	if (previousConfig.enabled && coordinator && restoreOptions) {
		await restoreAfterTravelModeDisabled(
			accountId,
			storage,
			coordinator,
			restoreOptions,
		);
	}
}
