import { describe, expect, test } from "bun:test";
import { VaultService } from "./vault-service";

describe("VaultService", () => {
	test("refreshes durable keys and the live repository projection together", async () => {
		let stored: unknown;
		let projected: unknown;
		const storage = {
			storeVaultKeys: async (keys: unknown) => {
				stored = keys;
			},
		} as never;
		const service = new VaultService({
			storage,
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

		await service.refreshVaultKeys("account-1");
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
