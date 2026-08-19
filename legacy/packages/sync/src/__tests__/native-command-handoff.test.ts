import { describe, expect, test } from "bun:test";
import { createNativeItemSyncCommand } from "../native-command-handoff";

describe("native Item command handoff", () => {
	test("preserves logical identity, OCC base, and exact AAD context", () => {
		const command = createNativeItemSyncCommand(
			{
				id: "native-operation",
				vaultId: "vault_1",
				itemId: "item_1",
				operation: "update_item",
				encryptedData: "ciphertext",
				encryptionIv: "iv",
				encryptionAlgorithm: "AES-GCM-AAD-V1",
				baseVersion: 4,
				encryptionVersion: 5,
				encryptedByUserId: "user_1",
				createdAt: 10,
			},
			{ accountId: "account_1", accountEmail: "alice@example.com" },
		);

		expect(command.operationId).toBe("native-operation");
		expect(command.baseVersion).toBe(4);
		expect(command.encryptedPayload?.encryptionVersion).toBe(5);
		expect(command.encryptedPayload?.encryptedByUserId).toBe("user_1");
	});

	test("rejects malformed context", () => {
		const handoff = {
			id: "malformed-operation",
			vaultId: "vault_1",
			itemId: "item_1",
			operation: "update_item",
			encryptedData: "ciphertext",
			encryptionIv: "iv",
			encryptionAlgorithm: "AES-GCM-AAD-V1",
			baseVersion: -1,
			encryptionVersion: -1,
			encryptedByUserId: "user_1",
			createdAt: 10,
		} as const;
		expect(() =>
			createNativeItemSyncCommand(handoff, {
				accountId: "account_1",
				accountEmail: "alice@example.com",
			}),
		).toThrow("has no exact encryption context");
		expect(() =>
			createNativeItemSyncCommand(
				{ ...handoff, baseVersion: 0, encryptionVersion: 1.5 },
				{ accountId: "account_1", accountEmail: "alice@example.com" },
			),
		).toThrow("has no exact encryption context");
	});
});
