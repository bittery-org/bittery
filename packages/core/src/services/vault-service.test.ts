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
		const vaultKeyProjection = { syncVaultKeys: async () => {} };
		const service = new VaultService({
			storage,
			crypto,
			vaultCrypto,
			accounts: {
				getClientForAccount: async () => ({
					vaults: {
						create: async (
							vaultId: string,
							input: {
								encryptedVaultKey: string;
							},
						) => {
							createdVaultId = vaultId;
							encryptedVaultKey = input.encryptedVaultKey;
							return { data: { vaultId } };
						},
					},
				}),
			} as never,
			vaultKeyProjection,
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

	test("refreshes durable keys and the live repository projection together", async () => {
		const crypto = createInMemoryCryptoPort();
		let stored: unknown;
		let projected: unknown;
		const storage = {
			storeVaultKeys: async (keys: unknown) => {
				stored = keys;
			},
		} as never;
		const service = new VaultService({
			storage,
			crypto,
			vaultCrypto: {} as never,
			accounts: {
				getClientForAccount: async () => ({
					vaults: {
						list: async () => ({
							data: [
								{
									id: "vault-1",
									name: "Personal",
									vaultType: "personal",
									icon: null,
									imageUrl: null,
									encryptedVaultKey: "wrapped",
									role: "owner",
								},
							],
						}),
					},
				}),
			} as never,
			vaultKeyProjection: {
				syncVaultKeys: async (keys, accountId) => {
					projected = { keys, accountId };
				},
			},
		});

		await service.refreshVaultKeys({} as never, "account-1");
		expect(stored).toEqual([
			{
				vaultId: "vault-1",
				vaultName: "Personal",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "wrapped",
				role: "owner",
			},
		]);
		expect(projected).toEqual({ keys: stored, accountId: "account-1" });
	});
});
