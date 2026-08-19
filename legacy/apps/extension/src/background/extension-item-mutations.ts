import type { ItemCommands } from "@bittery/core/services/item-commands";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";

export type ExtensionItemCommands = Pick<ItemCommands, "execute">;

interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountId: string;
}

interface UpdateItemInput {
	itemId: string;
	data: Partial<DecryptedItemData>;
	accountId: string;
}

/** Background callers share the same semantic command application service as UI hooks. */
export async function createExtensionItem(
	input: CreateItemInput,
	itemCommands: ExtensionItemCommands,
): Promise<{ itemId: string }> {
	const result = await itemCommands.execute({
		type: "create",
		vaultId: input.vaultId,
		category: input.category,
		data: input.data,
		accountId: input.accountId,
	});
	if (!result.itemId) {
		throw new Error("Create Item command did not produce an Item id");
	}
	return { itemId: result.itemId };
}

export async function updateExtensionItem(
	input: UpdateItemInput,
	itemCommands: ExtensionItemCommands,
): Promise<void> {
	await itemCommands.execute({
		type: "update",
		itemId: input.itemId,
		data: input.data,
		accountId: input.accountId,
	});
}
