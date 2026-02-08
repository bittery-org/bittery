/**
 * Vault Handlers
 * Handles vault and vault item operations.
 */

import type { DecryptedItem } from "@bittery/shared/types";
import { core } from "./core-instance";
import { updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";

async function getAllDecryptedItems(): Promise<Array<DecryptedItem | null>> {
	const { accountsInfo, isAllAccountsMode } =
		await core.accounts.resolveAccounts();
	return core.items.fetchAndDecryptItems(accountsInfo, { isAllAccountsMode });
}

async function resolveItemAccountEmail(
	itemId: string,
): Promise<string | undefined> {
	const { accountsInfo, isAllAccountsMode } =
		await core.accounts.resolveAccounts();
	if (!isAllAccountsMode) return undefined;

	const items = await core.items.fetchAndDecryptItems(accountsInfo, {
		isAllAccountsMode: true,
	});
	const item = items.find((candidate) => candidate.id === itemId);
	return item?.account?.email;
}

/**
 * Handle GET_VAULT_ITEMS message - Get all vault items
 */
export async function handleGetVaultItems(): Promise<MessageResponse> {
	updateActivity();

	const items = await getAllDecryptedItems();
	return {
		success: true,
		items,
	};
}

/**
 * Handle GET_VAULT_ITEM message - Get a specific vault item
 */
export async function handleGetVaultItem(payload: {
	itemId: string;
}): Promise<MessageResponse> {
	updateActivity();

	const { itemId } = payload;
	const accountEmail = await resolveItemAccountEmail(itemId);

	const result = await core.items.fetchAndDecryptItem(
		itemId,
		trpcClient as Parameters<typeof core.items.fetchAndDecryptItem>[1],
		accountEmail,
	);

	if (!result.rawItem || !result.decryptedData) {
		return { success: true, item: null };
	}

	return {
		success: true,
		item: {
			...result.rawItem,
			...result.decryptedData,
		},
	};
}

/**
 * Handle GET_WRITABLE_VAULTS message - Get vaults the user can write to
 */
export async function handleGetWritableVaults(): Promise<MessageResponse> {
	updateActivity();

	try {
		const vaults = await trpcClient.vault.list.query();
		const writableVaults = vaults.filter((vault) => vault.role !== "read-only");

		return {
			success: true,
			vaults: writableVaults.map((vault) => ({
				id: vault.id,
				name: vault.name,
				type: vault.type,
				role: vault.role,
			})),
		};
	} catch (error) {
		console.error("[vault-handlers] GET_WRITABLE_VAULTS failed:", error);
		return { success: false, error: String(error) };
	}
}
