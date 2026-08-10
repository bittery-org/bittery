import { getDefaultServerUrl } from "@bittery/shared/api-client-factory";
import type { ItemContextMetadata } from "@bittery/shared/types";
import type { AccountStore } from "@bittery/storage";
import type { ActiveAccountId } from "@bittery/storage/types";
import {
	createStoredAccountApiClient,
	type DefaultApiClient,
} from "./api-client";

export type { DefaultApiClient };
export { createStoredAccountApiClient };

/**
 * Complete account information including metadata, credentials, and API client.
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
	apiClient: DefaultApiClient;
}

export interface ResolveAccountsResult {
	activeAccount: ActiveAccountId;
	accountsInfo: AccountInfo[];
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
 * Returns an account-specific API client when accountId is provided.
 */
export async function getClientForAccount(
	storage: AccountStore,
	_defaultClient: DefaultApiClient,
	accountId: string,
): Promise<DefaultApiClient> {
	const client = await createStoredAccountApiClient(storage, accountId);
	if (!client) {
		throw new Error(`No authenticated API client for account ${accountId}`);
	}

	return client;
}

/**
 * Resolves active account configuration into per-account API clients.
 */
export class AccountResolver {
	constructor(private readonly storage: AccountStore) {}

	async resolveAccounts(
		activeAccountOverride?: ActiveAccountId,
	): Promise<ResolveAccountsResult> {
		const activeAccount =
			typeof activeAccountOverride === "undefined"
				? await this.storage.getActiveAccount()
				: activeAccountOverride;

		if (!activeAccount) {
			return {
				activeAccount,
				accountsInfo: [],
			};
		}

		const accountIds = [activeAccount];

		const accountsInfo = await this.buildAccountInfos(accountIds);

		return {
			activeAccount,
			accountsInfo,
		};
	}

	/**
	 * Resolves every currently-unlocked account into full `AccountInfo`.
	 *
	 * View-mode independent: used by the item Move dialog to surface
	 * cross-account move targets while a single account stays active. Does not
	 * change the active account or the coordinator's active-account set.
	 */
	async resolveUnlockedAccounts(): Promise<AccountInfo[]> {
		const accountIds = await this.storage.getUnlockedAccounts();
		return this.buildAccountInfos(accountIds);
	}

	private async buildAccountInfos(
		accountIds: string[],
	): Promise<AccountInfo[]> {
		const infos = await Promise.all(
			accountIds.map(async (accountId): Promise<AccountInfo | null> => {
				try {
					const [metadata, authToken, serverUrl] = await Promise.all([
						this.storage.getAccountMetadata(accountId),
						this.storage.getAuthToken(accountId),
						this.storage.getServerUrl(accountId),
					]);

					if (!metadata || !authToken) {
						return null;
					}

					const resolvedServerUrl = serverUrl || getDefaultServerUrl();
					const apiClient = await createStoredAccountApiClient(
						this.storage,
						accountId,
					);
					if (!apiClient) {
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
						apiClient: apiClient,
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

		return infos.filter((info): info is AccountInfo => info !== null);
	}

	async getClientForAccount(
		defaultClient: DefaultApiClient,
		accountId?: string,
	): Promise<DefaultApiClient> {
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
