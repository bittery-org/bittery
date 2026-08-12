import type { AccountStore } from "@bittery/storage";
import { AccountResolver } from "./account-resolver";
import type { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

export type StagedFullRefresh = (
	apiClient: unknown,
	accountId: string,
) => Promise<void>;

export type InitialSyncBootstrap = (
	apiClient: unknown,
	accountId: string,
	currentCursor: { id: string } | null,
) => Promise<{ id: string } | null>;

/**
 * Catch-up advances its cursor only once this resolves, so an account that
 * cannot be refreshed must throw instead of resolving silently — otherwise the
 * events the refresh was supposed to replace are skipped for good.
 *
 * The whole active set is re-hydrated, not just the target account:
 * `refreshFromServer` republishes the active accounts it is handed, so passing
 * one account would drop the others from the coordinator's active set.
 */
export function createStagedFullRefresh(
	storage: AccountStore,
	coordinator: VaultRepositoryCoordinator,
): StagedFullRefresh {
	const accounts = new AccountResolver(storage);

	return async (_apiClient, accountId) => {
		const { accountsInfo } = await accounts.resolveAccounts();
		if (!accountsInfo.some((account) => account.accountId === accountId)) {
			throw new Error(
				`Cannot stage a full refresh for account ${accountId}: it is not unlocked`,
			);
		}
		await coordinator.refreshFromServer(accountsInfo);
	};
}

export function createInitialSyncBootstrap(
	storage: AccountStore,
	coordinator: VaultRepositoryCoordinator,
): InitialSyncBootstrap {
	const accounts = new AccountResolver(storage);

	return async (_apiClient, accountId, currentCursor) => {
		const { accountsInfo } = await accounts.resolveAccounts();
		return coordinator.initializeSyncBaseline(
			accountsInfo,
			accountId,
			currentCursor,
		);
	};
}
