import type { AccountStore } from "@bittery/storage";
import type { AccountInfo, DefaultApiClient } from "./account-resolver";
import type { VaultRepository } from "./vault-repository";

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
 * The Sync source supplies its already-authenticated client. This remote path
 * enriches exactly that account and never changes the runtime-owned read scope.
 */
export function createStagedFullRefresh(
	storage: AccountStore,
	repository: VaultRepository,
): StagedFullRefresh {
	return async (apiClient, accountId) => {
		await repository.refreshFromServer([
			await remoteAccount(storage, accountId, apiClient as DefaultApiClient),
		]);
	};
}

export function createInitialSyncBootstrap(
	storage: AccountStore,
	repository: VaultRepository,
): InitialSyncBootstrap {
	return async (apiClient, accountId, currentCursor) => {
		return repository.initializeSyncBaseline(
			[await remoteAccount(storage, accountId, apiClient as DefaultApiClient)],
			accountId,
			currentCursor,
		);
	};
}

async function remoteAccount(
	storage: AccountStore,
	accountId: string,
	apiClient: DefaultApiClient,
): Promise<AccountInfo> {
	const [metadata, authToken, storedServerUrl] = await Promise.all([
		storage.getAccountMetadata(accountId),
		storage.getAuthToken(accountId),
		storage.getServerUrl(accountId),
	]);
	if (!metadata || !authToken) {
		throw new Error(`Cannot enrich unavailable Sync account ${accountId}`);
	}
	return {
		accountId,
		email: metadata.email,
		userId: metadata.userId,
		name: metadata.name,
		teamName: metadata.teamName,
		teamAvatarUrl: metadata.teamAvatarUrl,
		authToken,
		serverUrl: storedServerUrl || metadata.serverUrl,
		apiClient,
	};
}
