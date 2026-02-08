/**
 * Vault Utilities
 * Shared helpers for vault operations.
 */

import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import type { RawEncryptedItemWithVault } from "@bittery/types";
import type { MultiAccountItem } from "@bittery/core";
import type { AccountMetadata, ActiveAccount } from "@bittery/storage";
import { storage } from "../lib/storage";
import { core } from "./core-instance";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";

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

	const sessionData = await desktopClient.getSessionData();
	if (!sessionData) return [];

	return sessionData.accounts.map((account) => account.email.toLowerCase());
}

async function decryptVaultItemsForAccountViaDesktop(
	email: string,
	includeAccountContext: boolean,
): Promise<MultiAccountItem[]> {
	const authToken = await desktopClient.getAuthToken(email);
	if (!authToken) {
		console.warn(
			`[vault-utils] No auth token available from desktop for ${email}`,
		);
		return [];
	}

	const serverUrl = (await storage.getServerUrl(email)) || "http://localhost:3000";
	const accountClient = createAccountTrpcClient(authToken, serverUrl);
	const vaults = await accountClient.vault.list.query();

	const rawItems: RawEncryptedItemWithVault[] = [];
	for (const vault of vaults) {
		for (const item of vault.items ?? []) {
			if (item.deletedAt) continue;

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

	if (rawItems.length === 0) {
		return [];
	}

	const decryptedItems = await desktopClient.decryptItems(
		email,
		rawItems.map((item) => ({
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

	const accountMeta = includeAccountContext
		? ((await storage.getAccountMetadata?.(email)) ?? null)
		: null;

	const merged = rawItems.map((item) => {
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
			const desktopItems = await decryptVaultItemsViaDesktop();
			if (desktopItems.length > 0) {
				return desktopItems;
			}
		} catch (error) {
			console.warn(
				"[vault-utils] Desktop decryption failed, falling back to local decryption:",
				error,
			);
		}
	}

	const { accountsInfo, isAllAccountsMode } = await core.accounts.resolveAccounts();
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
