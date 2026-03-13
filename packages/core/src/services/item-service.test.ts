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

	test("falls back to older encryption versions when cached item metadata drifted", async () => {
		const attemptedVersions: number[] = [];
		const service = new ItemService({
			storage: {
				getCachedItems: async () => [
					{
						id: "item_1",
						vaultId: "vault_1",
						category: "login",
						favorite: false,
						encryptedData: "ciphertext",
						encryptionIv: "iv",
						encryptionAlgorithm: "AES-GCM-AAD-V1",
						version: 3,
						lastModifiedBy: "user_1",
						createdAt: "2026-03-13T00:00:00.000Z",
						updatedAt: "2026-03-13T00:00:00.000Z",
						deletedAt: null,
						attachments: [],
					},
				],
				getVaultKeys: async () => [
					{
						vaultId: "vault_1",
						encryptedVaultKey: JSON.stringify({
							ciphertext: "wrapped",
							iv: "vault-iv",
							algorithm: "AES-GCM-AAD-V1",
							context: {
								vaultId: "vault_1",
								userId: "user_1",
								keyVersion: 1,
								purpose: "vault-key-wrap",
							},
						}),
					},
				],
				getMasterUnlockKey: async () => new Uint8Array([1, 2, 3]),
				getEncryptedPrivateKey: async () => null,
				getStoredSessionData: async () => ({ userId: "user_1" }),
				getActiveAccountUserId: async () => "user_1",
			} as never,
			crypto: {
				decrypt: async (_encryptedData, _key, context) => {
					if (context?.entityType === "vault_key") {
						return Buffer.from("vault-key").toString("base64");
					}
					if (context?.entityType === "item") {
						attemptedVersions.push(context.version);
						if (context.version === 1) {
							return JSON.stringify({ title: "Recovered item" });
						}
					}
					throw new Error("AAD mismatch");
				},
			} as never,
			accounts: {} as never,
		});

		const result = await service.fetchAndDecryptItem(
			"item_1",
			{} as never,
			"alice@example.com",
		);

		expect(attemptedVersions).toEqual([3, 2, 1]);
		expect(result.decryptedData?.title).toBe("Recovered item");
	});
});
