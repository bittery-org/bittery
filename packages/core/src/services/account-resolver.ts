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
 * Returns an account-specific RPC client when accountEmail is provided.
 */
export async function getClientForAccount(
	storage: IStorageAdapter,
	defaultClient: DefaultRpcClient,
	accountEmail?: string,
): Promise<DefaultRpcClient> {
	if (!accountEmail) {
		return defaultClient;
	}

	const [authToken, serverUrl] = await Promise.all([
		storage.getAuthToken(accountEmail),
		storage.getServerUrl(accountEmail),
	]);

	if (!authToken) {
		return defaultClient;
	}

	return createAccountRpcClient(authToken, serverUrl);
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

		const emails =
			activeAccount.type === "single"
				? [activeAccount.email]
				: ((await this.storage.getUnlockedAccounts?.()) ?? []);

		const infos = await Promise.all(
			emails.map(async (email): Promise<AccountInfo | null> => {
				try {
					const [metadata, authToken, serverUrl] = await Promise.all([
						this.storage.getAccountMetadata?.(email),
						this.storage.getAuthToken(email),
						this.storage.getServerUrl(email),
					]);

					if (!metadata || !authToken) {
						return null;
					}

					const resolvedServerUrl = serverUrl || getDefaultServerUrl();
					const rpcClient = createAccountRpcClient(
						authToken,
						resolvedServerUrl,
					);

					return {
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
						`[AccountResolver] Failed to load account info for ${email}:`,
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
		accountEmail?: string,
	): Promise<DefaultRpcClient> {
		return getClientForAccount(this.storage, defaultClient, accountEmail);
	}

	findAccountForItem(
		itemId: string,
		items: Array<ItemWithOptionalAccount | null | undefined>,
	): string | undefined {
		return findAccountForItem(itemId, items);
	}
}
