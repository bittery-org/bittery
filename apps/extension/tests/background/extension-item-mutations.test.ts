import { describe, expect, test } from "bun:test";
import type { DecryptedItemData } from "@bittery/shared/types";
import type { ItemSyncCommand } from "@bittery/types";
import { createExtensionItemMutationModule } from "../../src/background/extension-item-mutations";

const EXISTING_DATA: DecryptedItemData = {
	title: "Example",
	url: "https://example.com",
	username: "alice",
	password: "old-password",
};

function createFixture() {
	const commands: ItemSyncCommand[] = [];
	const encryptionContexts: Array<{
		itemId?: string;
		version?: number;
		userId?: string;
	}> = [];
	let enqueueCompleted = false;
	const item = {
		id: "item-1",
		vaultId: "vault-1",
		category: "login",
		version: 7,
		...EXISTING_DATA,
	};
	const repo = {
		getById: (itemId: string) => (itemId === item.id ? item : undefined),
		encryptWithVaultKey: async (
			_vaultId: string,
			_data: DecryptedItemData,
			context: { itemId?: string; version?: number; userId?: string },
		) => {
			encryptionContexts.push(context);
			return {
				ciphertext: `sealed-for-${context.version}`,
				iv: "iv",
				algorithm: "AES-GCM-AAD-V1",
				encryptionVersion: context.version,
				encryptedByUserId: "actual-user-id",
			};
		},
	};
	const module = createExtensionItemMutationModule({
		generateItemId: async () => "new-item-id",
		mergeItemUpdate: (existing, update) => ({ ...existing, ...update }),
		resolveAccountIdByEmail: () => "account-1",
		getRepositoryForAccount: () => repo,
		getItemById: (itemId) => (itemId === item.id ? item : undefined),
		enqueue: async (command) => {
			commands.push(command);
			await Promise.resolve();
			enqueueCompleted = true;
		},
		now: () => 123,
		newOperationId: () => "operation-1",
	});

	return {
		commands,
		encryptionContexts,
		getEnqueueCompleted: () => enqueueCompleted,
		module,
	};
}

describe("extension Item mutations", () => {
	test("updates remain decryptable after restart with the next revision and actual authenticated author", async () => {
		const fixture = createFixture();

		await fixture.module.update({
			itemId: "item-1",
			data: { password: "new-password" },
			accountEmail: "alice@example.com",
		});

		expect(fixture.encryptionContexts).toEqual([
			{ itemId: "item-1", version: 8 },
		]);
		expect(fixture.commands[0]).toMatchObject({
			type: "update",
			entityId: "item-1",
			baseVersion: 7,
			encryptedPayload: {
				encryptedData: "sealed-for-8",
				encryptionVersion: 8,
				encryptedByUserId: "actual-user-id",
			},
		});

		const restoredPayload = fixture.commands[0]?.encryptedPayload;
		if (!restoredPayload)
			throw new Error("Expected a durable encrypted payload");
		const openAfterRestart = (version: number, userId: string) => {
			if (version !== 8 || userId !== "actual-user-id") {
				throw new Error("AAD context mismatch");
			}
			return restoredPayload.encryptedData;
		};
		expect(
			openAfterRestart(
				restoredPayload.encryptionVersion,
				restoredPayload.encryptedByUserId,
			),
		).toBe("sealed-for-8");
	});

	test("returns success only after the semantic command is durable", async () => {
		const fixture = createFixture();

		const result = await fixture.module.create({
			vaultId: "vault-1",
			category: "login",
			data: EXISTING_DATA,
			accountEmail: "alice@example.com",
		});

		expect(result.itemId).toBe("new-item-id");
		expect(fixture.getEnqueueCompleted()).toBe(true);
		expect(fixture.commands[0]).toMatchObject({
			type: "create",
			entityId: "new-item-id",
			baseVersion: 0,
			encryptedPayload: {
				encryptionVersion: 1,
				encryptedByUserId: "actual-user-id",
			},
		});
	});
});
