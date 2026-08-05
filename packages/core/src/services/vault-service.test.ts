import { describe, expect, test } from "bun:test";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import { createVaultCrypto } from "./vault-crypto";
import { VaultService } from "./vault-service";

describe("VaultService.createVault", () => {
	test("persists an owner-wrapped vault key that VaultCrypto can reopen", async () => {
		const crypto = createInMemoryCryptoPort();
		const masterUnlockKey = await crypto.importKey(new Uint8Array(32).fill(7));
		let encryptedVaultKey: string | undefined;
		let createdVaultId: string | undefined;
		const storage = {
			getMasterUnlockKey: async () => masterUnlockKey,
			getVaultKeys: async () => null,
			getEncryptedPrivateKey: async () => null,
			getStoredSessionData: async () => ({ userId: "user_1" }),
			getPinnedKdfProfile: async () => null,
		} as never;
		const vaultCrypto = createVaultCrypto({ crypto, storage });
		const service = new VaultService({
			storage,
			crypto,
			vaultCrypto,
			accounts: {
				getClientForAccount: async () => ({
					vault: {
						create: {
							mutate: async (input: {
								vaultId: string;
								encryptedVaultKey: string;
							}) => {
								createdVaultId = input.vaultId;
								encryptedVaultKey = input.encryptedVaultKey;
								return { vaultId: input.vaultId };
							},
						},
					},
				}),
			} as never,
		});

		const result = await service.createVault(
			{
				name: "Personal",
				type: "personal",
				icon: "lock",
				accountId: "account_1",
			},
			{} as never,
		);

		expect(createdVaultId).toBeDefined();
		if (!createdVaultId)
			throw new Error("Create mutation received no vault ID");
		expect(result.vaultId).toBe(createdVaultId);
		expect(encryptedVaultKey).toBeDefined();
		const parsed = JSON.parse(encryptedVaultKey ?? "") as {
			context?: Record<string, unknown>;
		};
		expect(parsed.context).toEqual({
			vaultId: createdVaultId,
			userId: "user_1",
			keyVersion: 1,
			purpose: "vault-key-wrap",
		});

		const reopened = await vaultCrypto.unwrapVaultKey({
			encryptedVaultKey: encryptedVaultKey ?? "",
			masterUnlockKey,
			expectedVaultId: createdVaultId ?? "",
			expectedUserId: "user_1",
		});
		await crypto.destroyKey(reopened);
		await crypto.destroyKey(masterUnlockKey);
		expect(crypto.liveKeyCount).toBe(0);
	});
});
