/**
 * Vault Utilities
 * Shared helpers for vault operations.
 */

import type { MultiAccountItem } from "@bittery/core";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import type { AccountMetadata, ActiveAccount } from "@bittery/storage";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	RawEncryptedItemWithVault,
} from "@bittery/types";
import { storage } from "../lib/storage";
import { core } from "./core-instance";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";

type AccountTrpcClient = ReturnType<typeof createAccountTrpcClient>;
type VaultListResponse = Awaited<
	ReturnType<AccountTrpcClient["vault"]["list"]["query"]>
>;

type DesktopAccountContext = {
	email: string;
	userId: string;
	name: string;
};

function isDesktopDecryptionAvailable(): boolean {
	const status = desktopSync.getLastStatus();
	return Boolean(status?.available && !status.locked);
}

function buildAccountContext(
	account: AccountMetadata | null,
	email: string,
): DesktopAccountContext {
	return {
		email: account?.email ?? email,
		userId: account?.userId ?? "",
		name: account?.name ?? email,
	};
}

async function getDesktopTargetEmails(
	activeAccount: ActiveAccount,
): Promise<string[]> {
	if (activeAccount?.type === "single") {
		return [activeAccount.email.toLowerCase()];
	}

	const statusEmails = desktopSync
		.getLastStatus()
		?.unlockedAccounts?.map((email) => email.toLowerCase());
	if (statusEmails && statusEmails.length > 0) {
		return Array.from(new Set(statusEmails));
	}

	const sessionData = await desktopClient.getSessionData();
	if (!sessionData) return [];

	return Array.from(
		new Set(sessionData.accounts.map((account) => account.email.toLowerCase())),
	);
}

function buildRawItemsFromVaultList(vaults: VaultListResponse) {
	const rawItems: RawEncryptedItemWithVault[] = [];
	for (const vault of vaults) {
		for (const item of vault.items ?? []) {
			rawItems.push({
				id: item.id,
				vaultId: item.vaultId,
				category: item.category,
				favorite: item.favorite,
				encryptedData: item.encryptedData,
				encryptionIv: item.encryptionIv,
				encryptionAlgorithm: item.encryptionAlgorithm,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				deletedAt: item.deletedAt,
				vault: {
					id: vault.id,
					name: vault.name,
					type: vault.type,
					icon: vault.icon,
					imageUrl: vault.imageUrl,
				},
			});
		}
	}
	return rawItems;
}

function buildCachedItemsFromVaultList(vaults: VaultListResponse) {
	const cachedItems: CachedEncryptedItem[] = [];
	for (const vault of vaults) {
		for (const item of vault.items ?? []) {
			cachedItems.push({
				id: item.id,
				vaultId: item.vaultId,
				category: item.category,
				favorite: item.favorite,
				encryptedData: item.encryptedData,
				encryptionIv: item.encryptionIv,
				encryptionAlgorithm: item.encryptionAlgorithm,
				version: item.version ?? 0,
				lastModifiedBy: item.lastModifiedBy ?? null,
				createdAt: String(item.createdAt),
				updatedAt: String(item.updatedAt),
				deletedAt: item.deletedAt ? String(item.deletedAt) : null,
			});
		}
	}
	return cachedItems;
}

function buildCachedVaultsFromVaultList(vaults: VaultListResponse) {
	return vaults.map((vault) => ({
		id: vault.id,
		name: vault.name,
		type: vault.type,
		icon: vault.icon,
		imageUrl: vault.imageUrl,
	})) satisfies CachedVaultMetadata[];
}

function buildRawItemsFromCache(
	cachedItems: CachedEncryptedItem[],
	cachedVaults: CachedVaultMetadata[],
) {
	const vaultMap = new Map(cachedVaults.map((vault) => [vault.id, vault]));

	return cachedItems.map((item) => {
		const vault = vaultMap.get(item.vaultId);
		return {
			id: item.id,
			vaultId: item.vaultId,
			category: item.category,
			favorite: item.favorite,
			encryptedData: item.encryptedData,
			encryptionIv: item.encryptionIv,
			encryptionAlgorithm: item.encryptionAlgorithm,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			deletedAt: item.deletedAt,
			vault: vault
				? {
						id: vault.id,
						name: vault.name,
						type: vault.type,
						icon: vault.icon,
						imageUrl: vault.imageUrl,
					}
				: {
						id: item.vaultId,
						name: "Unknown",
						type: "personal",
						icon: null,
						imageUrl: null,
					},
		};
	}) satisfies RawEncryptedItemWithVault[];
}

async function decryptRawItemsViaDesktop(
	rawItems: RawEncryptedItemWithVault[],
	email: string,
	includeAccountContext: boolean,
) {
	const accountMeta = includeAccountContext
		? ((await storage.getAccountMetadata?.(email)) ?? null)
		: null;

	const nonDeletedItems = rawItems.filter((item) => !item.deletedAt);
	if (nonDeletedItems.length === 0) {
		return [];
	}

	const decryptedItems = await desktopClient.decryptItems(
		email,
		nonDeletedItems.map((item) => ({
			id: item.id,
			vaultId: item.vaultId,
			encryptedData: item.encryptedData,
			encryptionIv: item.encryptionIv,
			encryptionAlgorithm: item.encryptionAlgorithm,
		})),
	);
	const decryptedById = new Map(
		decryptedItems.map((item) => [item.id, item.decrypted_data]),
	);

	const merged = nonDeletedItems.map((item) => {
		const decryptedJson = decryptedById.get(item.id);
		if (!decryptedJson) return null;

		try {
			const decryptedData = JSON.parse(decryptedJson) as DecryptedItemData;
			const resolved: MultiAccountItem = {
				id: item.id,
				vaultId: item.vaultId,
				category: item.category as ItemCategory,
				favorite: item.favorite,
				createdAt: String(item.createdAt),
				updatedAt: String(item.updatedAt),
				...decryptedData,
				vault: item.vault,
			};

			if (includeAccountContext) {
				resolved.account = buildAccountContext(accountMeta, email);
			}

			return resolved;
		} catch (error) {
			console.error(
				`[vault-utils] Failed to parse decrypted item ${item.id}:`,
				error,
			);
			return null;
		}
	});

	return merged.filter((item): item is MultiAccountItem => item !== null);
}

async function decryptVaultItemsForAccountViaDesktop(
	email: string,
	includeAccountContext: boolean,
): Promise<MultiAccountItem[]> {
	if (storage.supportsItemCache) {
		const [cachedItems, cachedVaults, cacheMeta] = await Promise.all([
			storage.getCachedItems?.(email),
			storage.getCachedVaults?.(email),
			storage.getItemCacheMetadata?.(email),
		]);

		const hasCacheSnapshot =
			!!cachedItems &&
			!!cachedVaults &&
			(cachedItems.length > 0 || cacheMeta !== null);
		if (hasCacheSnapshot) {
			try {
				return await decryptRawItemsViaDesktop(
					buildRawItemsFromCache(cachedItems, cachedVaults),
					email,
					includeAccountContext,
				);
			} catch (error) {
				console.warn(
					`[vault-utils] Cache decrypt failed for ${email}, refetching from server:`,
					error,
				);
			}
		}
	}

	const authToken = await desktopClient.getAuthToken(email);
	if (!authToken) {
		console.warn(
			`[vault-utils] No auth token available from desktop for ${email}`,
		);
		return [];
	}

	const serverUrl =
		(await storage.getServerUrl(email)) || "http://localhost:3000";
	const accountClient = createAccountTrpcClient(authToken, serverUrl);
	const vaults = await accountClient.vault.list.query();
	const rawItems = buildRawItemsFromVaultList(vaults);

	if (storage.supportsItemCache) {
		await core.cache.populateFromServerResponse(
			buildCachedItemsFromVaultList(vaults),
			buildCachedVaultsFromVaultList(vaults),
			email,
		);
	}

	return decryptRawItemsViaDesktop(rawItems, email, includeAccountContext);
}

async function decryptVaultItemsViaDesktop(): Promise<MultiAccountItem[]> {
	const activeAccount = await storage.getActiveAccount();
	const targetEmails = await getDesktopTargetEmails(activeAccount);

	if (targetEmails.length === 0) {
		return [];
	}

	const includeAccountContext = activeAccount?.type === "all";
	const results = await Promise.all(
		targetEmails.map((email) =>
			decryptVaultItemsForAccountViaDesktop(email, includeAccountContext),
		),
	);

	return results.flat();
}

/**
 * Get decrypted items for current runtime mode.
 * Uses desktop bridge decryption in desktop mode and falls back to core/local decryption.
 */
export async function getDecryptedItemsForCurrentMode(): Promise<
	Array<DecryptedItem | null>
> {
	if (isDesktopDecryptionAvailable()) {
		try {
			return await decryptVaultItemsViaDesktop();
		} catch (error) {
			console.warn(
				"[vault-utils] Desktop decryption failed, falling back to local decryption:",
				error,
			);
		}
	}

	const { accountsInfo, isAllAccountsMode } =
		await core.accounts.resolveAccounts();
	return core.items.fetchAndDecryptItems(accountsInfo, { isAllAccountsMode });
}

/**
 * Helper function to get base domain from hostname
 */
export function getBaseDomain(host: string): string {
	const parts = host.split(".");
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

/**
 * Helper function to check if hostname matches
 */
export function hostnameMatches(
	itemUrl: string,
	targetHostname: string,
): boolean {
	if (!itemUrl) return false;

	try {
		const itemUrlObj = new URL(
			itemUrl.startsWith("http") ? itemUrl : `https://${itemUrl}`,
		);
		const itemHostname = itemUrlObj.hostname;

		if (itemHostname === targetHostname) return true;

		if (
			itemHostname.endsWith(`.${targetHostname}`) ||
			targetHostname.endsWith(`.${itemHostname}`)
		) {
			return true;
		}

		const itemBaseDomain = getBaseDomain(itemHostname);
		const hostnameBaseDomain = getBaseDomain(targetHostname);

		return itemBaseDomain === hostnameBaseDomain;
	} catch {
		return false;
	}
}
