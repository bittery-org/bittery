import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { AccountResolver } from "./account-resolver";
import { getTravelModeService } from "./travel-mode-service";
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
	email: string,
	storage: IStorageAdapter,
	coordinator: VaultRepositoryCoordinator,
	{ rpcClient, accounts }: TravelModeSyncRestoreOptions,
): Promise<void> {
	await refreshVaultKeys(rpcClient, storage, email);

	const vaultKeys = await storage.getVaultKeys(email);
	if (vaultKeys) {
		await coordinator.syncVaultKeys(vaultKeys, email);
	}

	const { accountsInfo } = await accounts.resolveAccounts();
	const account = accountsInfo.find(
		(candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
	);
	if (account) {
		await coordinator.refreshFromServer([account]);
	}
}

export async function handleTravelModeSyncEvent(
	event: TravelModeSyncEvent,
	email: string,
	storage: IStorageAdapter,
	coordinator?: VaultRepositoryCoordinator,
	restoreOptions?: TravelModeSyncRestoreOptions,
): Promise<void> {
	if (event.type !== "travel_mode_updated") {
		return;
	}

	const travelMode = getTravelModeService(storage);
	const previousConfig = travelMode.getConfig(email);
	await travelMode.applySyncEventMetadata(email, event.metadata);
	const config = travelMode.getConfig(email);

	if (config.enabled) {
		coordinator?.purgeHiddenVaultsForEmail(email, config.hiddenVaultIds);
		return;
	}

	if (previousConfig.enabled && coordinator && restoreOptions) {
		await restoreAfterTravelModeDisabled(
			email,
			storage,
			coordinator,
			restoreOptions,
		);
	}
}
