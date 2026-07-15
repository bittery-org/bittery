import {
	createAccountRpcClient,
	getDefaultServerUrl,
} from "@bittery/shared/rpc-client-factory";
import type { ItemContextMetadata } from "@bittery/shared/types";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { ActiveAccount } from "@bittery/storage/types";

export type DefaultRpcClient = ReturnType<typeof createAccountRpcClient>;

/**
 * Complete account information including metadata, credentials, and RPC client.
 */
export interface AccountInfo {
	accountId: string;
	email: string;
	userId: string;
	name: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
	authToken: string;
	serverUrl: string;
	rpcClient: DefaultRpcClient;
}

export interface ResolveAccountsResult {
	activeAccount: ActiveAccount;
	accountsInfo: AccountInfo[];
	isAllAccountsMode: boolean;
}

export interface ItemWithOptionalAccount extends ItemContextMetadata {
	id: string;
}

/**
 * Extracts the account email from an item if it has account metadata.
 */
export function getItemAccountEmail(
	item: ItemWithOptionalAccount | null | undefined,
): string | undefined {
	if (!item) return undefined;
	return item.accountEmail ?? item.account?.email;
}

/**
 * Finds the account email for a specific item by searching through a list of items.
 */
export function findAccountForItem(
	itemId: string,
	items: Array<ItemWithOptionalAccount | null | undefined>,
): string | undefined {
	const item = items.find((candidate) => candidate?.id === itemId);
	return getItemAccountEmail(item);
}

/**
 * Returns an account-specific RPC client when accountId is provided.
 */
export async function getClientForAccount(
	storage: IStorageAdapter,
	_defaultClient: DefaultRpcClient,
	accountId: string,
): Promise<DefaultRpcClient> {
	const client = await createStoredAccountRpcClient(storage, accountId);
	if (!client) {
		throw new Error(`No authenticated RPC client for account ${accountId}`);
	}

	return client;
}

export async function createStoredAccountRpcClient(
	storage: IStorageAdapter,
	accountId: string,
	clientId?: string,
): Promise<DefaultRpcClient | null> {
	const [authToken, serverUrl] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getServerUrl(accountId),
	]);

	if (!authToken) {
		return null;
	}

	const resolvedServerUrl = serverUrl || getDefaultServerUrl();
	return createAccountRpcClient(authToken, resolvedServerUrl, clientId, {
		getSessionSnapshot: async () => {
			const [token, sessionData] = await Promise.all([
				storage.getAuthToken(accountId),
				storage.getStoredSessionData?.(accountId),
			]);
			return {
				token,
				issuedAt: sessionData?.createdAt ?? null,
				expiresAt: sessionData?.expiresAt ?? null,
			};
		},
		getRefreshToken: () => storage.getAuthToken(accountId),
		storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
			await storage.storeAuthToken(token, accountId);
			await storage.updateStoredSessionMetadata?.(accountId, {
				sessionId,
				expiresAt,
			});
		},
		appPlatform: storage.platform,
	});
}

/**
 * Resolves active account configuration into per-account API clients.
 */
export class AccountResolver {
	constructor(private readonly storage: IStorageAdapter) {}

	async resolveAccounts(
		activeAccountOverride?: ActiveAccount,
	): Promise<ResolveAccountsResult> {
		const activeAccount =
			typeof activeAccountOverride === "undefined"
				? await this.storage.getActiveAccount()
				: activeAccountOverride;

		if (!activeAccount) {
			return {
				activeAccount,
				accountsInfo: [],
				isAllAccountsMode: false,
			};
		}

		const accountIds =
			activeAccount.type === "single"
				? [activeAccount.accountId]
				: ((await this.storage.getUnlockedAccounts?.()) ?? []);

		const infos = await Promise.all(
			accountIds.map(async (accountId): Promise<AccountInfo | null> => {
				try {
					const [metadata, authToken, serverUrl] = await Promise.all([
						this.storage.getAccountMetadata?.(accountId),
						this.storage.getAuthToken(accountId),
						this.storage.getServerUrl(accountId),
					]);

					if (!metadata || !authToken) {
						return null;
					}

					const resolvedServerUrl = serverUrl || getDefaultServerUrl();
					const rpcClient = await createStoredAccountRpcClient(
						this.storage,
						accountId,
					);
					if (!rpcClient) {
						return null;
					}

					return {
						accountId: metadata.accountId,
						email: metadata.email,
						userId: metadata.userId,
						name: metadata.name,
						teamName: metadata.teamName,
						teamAvatarUrl: metadata.teamAvatarUrl,
						authToken,
						serverUrl: resolvedServerUrl,
						rpcClient: rpcClient,
					};
				} catch (error) {
					console.error(
						`[AccountResolver] Failed to load account info for ${accountId}:`,
						error,
					);
					return null;
				}
			}),
		);

		return {
			activeAccount,
			accountsInfo: infos.filter((info): info is AccountInfo => info !== null),
			isAllAccountsMode: activeAccount.type === "all",
		};
	}

	async getClientForAccount(
		defaultClient: DefaultRpcClient,
		accountId?: string,
	): Promise<DefaultRpcClient> {
		if (!accountId) return defaultClient;
		return getClientForAccount(this.storage, defaultClient, accountId);
	}

	findAccountForItem(
		itemId: string,
		items: Array<ItemWithOptionalAccount | null | undefined>,
	): string | undefined {
		return findAccountForItem(itemId, items);
	}
}
