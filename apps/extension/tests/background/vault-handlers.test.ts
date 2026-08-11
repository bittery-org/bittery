import { describe, expect, mock, test } from "bun:test";
import path from "node:path";

const backgroundDir = path.resolve(import.meta.dir, "../../src/background");

mock.module(path.join(backgroundDir, "api-client.ts"), () => ({
	apiClient: {},
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
	test("returns the Item opened by id", async () => {
		const response = await handleGetVaultItem({ itemId: "item-1" });
		expect(response).toMatchObject({
			success: true,
			item: { id: "item-1", title: "Opened Item" },
		});
	});

	test("returns the available Items", async () => {
		const response = await handleGetVaultItems();
		expect(response).toMatchObject({ success: true });
	});
});
