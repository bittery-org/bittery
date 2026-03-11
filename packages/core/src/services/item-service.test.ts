import { describe, expect, test } from "bun:test";
import { ItemService } from "./item-service";

describe("ItemService", () => {
	test("uses account metadata userId when session metadata is missing", async () => {
		const encryptCalls: Array<{ context?: { userId?: string } }> = [];
		const service = new ItemService({
			storage: {
				getVaultKeys: async () => [
					{
						vaultId: "vault_1",
						encryptedVaultKey: JSON.stringify({
							ciphertext: "wrapped",
							iv: "vault-iv",
							algorithm: "aes-256-gcm",
							context: {
								vaultId: "vault_1",
								userId: "user_from_account_metadata",
								keyVersion: 1,
								purpose: "vault-key-wrap",
							},
						}),
					},
				],
				getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
				getEncryptedPrivateKey: async () => null,
				getStoredSessionData: async () => null,
				getAccountMetadata: async () => ({
					email: "alice@example.com",
					userId: "user_from_account_metadata",
					name: "Alice",
					secretKeyHint: "",
					addedAt: 0,
					lastActiveAt: 0,
					biometricEnabled: false,
				}),
				getActiveAccountUserId: async () => null,
			} as never,
			crypto: {
				generateUuid: async () => "item_123",
				decrypt: async () => Buffer.from("vault-key").toString("base64"),
				encrypt: async (_plaintext, _key, context) => {
					encryptCalls.push({ context });
					return {
						ciphertext: "ciphertext",
						iv: "iv",
						algorithm: "aes-256-gcm",
					};
				},
			} as never,
			accounts: {
				getClientForAccount: async () => ({
					vault: {
						createItem: {
							mutate: async ({ itemId }: { itemId: string }) => ({
								itemId,
							}),
						},
					},
				}),
			} as never,
		});

		await service.createItem(
			{
				vaultId: "vault_1",
				category: "login",
				data: {
					title: "example.com",
				},
				accountEmail: "alice@example.com",
			},
			{} as never,
		);

		expect(encryptCalls).toHaveLength(1);
		expect(encryptCalls[0]?.context?.userId).toBe(
			"user_from_account_metadata",
		);
	});
});
