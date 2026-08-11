import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

const backgroundDir = path.resolve(import.meta.dir, "../../src/background");
const publishedItemIds: string[] = [];

mock.module(path.join(backgroundDir, "api-client.ts"), () => ({
	apiClient: {},
}));

mock.module(path.join(backgroundDir, "outbound-drain.ts"), () => ({
	publishOpenedItemEncryptionContextMigration: async (itemId: string) => {
		publishedItemIds.push(itemId);
	},
}));

mock.module(path.join(backgroundDir, "session-manager.ts"), () => ({
	updateActivity: () => {},
}));

mock.module(path.join(backgroundDir, "vault-utils.ts"), () => ({
	getDecryptedItemsForCurrentMode: async () => [
		{ id: "item-1", title: "Opened Item" },
		{ id: "item-2", title: "List-only Item" },
	],
}));

const { handleGetVaultItem, handleGetVaultItems } = await import(
	"../../src/background/vault-handlers"
);

describe("extension vault handlers", () => {
	test("only publishes a legacy encryption migration for the Item opened by id", async () => {
		await handleGetVaultItems();
		expect(publishedItemIds).toEqual([]);

		const response = await handleGetVaultItem({ itemId: "item-1" });
		expect(response).toMatchObject({
			success: true,
			item: { id: "item-1", title: "Opened Item" },
		});
		expect(publishedItemIds).toEqual(["item-1"]);
	});
});
