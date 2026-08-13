import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type { TravelModeConfig, VaultKeyData } from "@bittery/storage/types";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
} from "../testing/account-store-harness";
import type { AccountResolver } from "./account-resolver";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import {
	handleTravelModeSyncEvent,
	restoreAfterTravelModeDisabled,
} from "./travel-mode-sync";
import type { VaultRepository } from "./vault-repository";
import type { ApiVaultClient } from "./vault-service";

const ACCOUNT_ID = "account-1";

/** Real `AccountStore` + real `ItemCache` over the in-memory ports, as the enforcer actually purges them. */
async function createLayers(options: {
	vaultKeys?: VaultKeyData[];
	travelModeCache?: TravelModeConfig;
}): Promise<{ storage: AccountStore; itemCache: ItemCache }> {
	const { store } = await createTestAccountStore();
	const { cache } = await createTestItemCache();
	await store.addAccount(accountMetadata({ accountId: ACCOUNT_ID }));
	await store.storeVaultKeys(options.vaultKeys ?? [], ACCOUNT_ID);
	if (options.travelModeCache) {
		await store.storeTravelModeCache(options.travelModeCache, ACCOUNT_ID);
	}
	return { storage: store, itemCache: cache };
}

describe("travel-mode-sync", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("restores vault keys and refreshes coordinator after travel mode is disabled", async () => {
		const vaultKeys: VaultKeyData[] = [
			{
				vaultId: "vault-1",
				vaultName: "Private",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "encrypted",
				role: "owner",
			},
		];

		const { storage } = await createLayers({
			vaultKeys,
			travelModeCache: { enabled: false, hiddenVaultIds: ["vault-1"] },
		});
		const storeVaultKeys = spyOn(storage, "storeVaultKeys");

		const apiClient = {
			vaults: {
				list: mock(async () => ({
					data: [
						{
							id: "vault-1",
							name: "Private",
							vaultType: "personal",
							icon: null,
							imageUrl: null,
							encryptedVaultKey: "encrypted",
							role: "owner",
						},
					],
				})),
			},
		} as unknown as ApiVaultClient;

		const coordinator = {
			syncVaultKeys: mock(async () => undefined),
			refreshFromServer: mock(async () => undefined),
		} as unknown as VaultRepository;

		const accounts = {
			resolveAccounts: mock(async () => ({
				accountsInfo: [
					{
						accountId: ACCOUNT_ID,
						email: "user@example.com",
						apiClient,
					},
				],
			})),
		} as unknown as AccountResolver;

		await restoreAfterTravelModeDisabled(ACCOUNT_ID, storage, coordinator, {
			apiClient,
			accounts,
		});

		expect(apiClient.vaults.list).toHaveBeenCalled();
		expect(storeVaultKeys).toHaveBeenCalledWith(vaultKeys, ACCOUNT_ID);
		expect(coordinator.syncVaultKeys).toHaveBeenCalledWith(
			vaultKeys,
			ACCOUNT_ID,
		);
		expect(coordinator.refreshFromServer).toHaveBeenCalled();
	});

	it("restores vault access when a sync event disables travel mode", async () => {
		const vaultKeys: VaultKeyData[] = [
			{
				vaultId: "vault-1",
				vaultName: "Private",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "encrypted",
				role: "owner",
			},
		];

		const { storage, itemCache } = await createLayers({
			vaultKeys,
			travelModeCache: { enabled: true, hiddenVaultIds: ["vault-1"] },
		});

		const apiClient = {
			vaults: {
				list: mock(async () => ({
					data: [
						{
							id: "vault-1",
							name: "Private",
							vaultType: "personal",
							icon: null,
							imageUrl: null,
							encryptedVaultKey: "encrypted",
							role: "owner",
						},
					],
				})),
			},
		} as unknown as ApiVaultClient;

		const coordinator = {
			purgeHiddenVaultsForAccount: mock(() => undefined),
			syncVaultKeys: mock(async () => undefined),
			refreshFromServer: mock(async () => undefined),
		} as unknown as VaultRepository;

		const accounts = {
			resolveAccounts: mock(async () => ({
				accountsInfo: [
					{
						accountId: ACCOUNT_ID,
						email: "user@example.com",
						apiClient,
					},
				],
			})),
		} as unknown as AccountResolver;

		const enforcer = getTravelModeEnforcer(storage, itemCache, coordinator);
		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: true,
			hiddenVaultIds: ["vault-1"],
			enabledAt: Date.now(),
			updatedAt: Date.now(),
		});
		(
			coordinator.purgeHiddenVaultsForAccount as ReturnType<typeof mock>
		).mockClear();

		await handleTravelModeSyncEvent(
			{
				type: "travel_mode_updated",
				metadata: {
					enabled: false,
					hiddenVaultIds: ["vault-1"],
				},
			},
			ACCOUNT_ID,
			storage,
			itemCache,
			coordinator,
			{ apiClient, accounts },
		);

		expect(coordinator.purgeHiddenVaultsForAccount).not.toHaveBeenCalled();
		expect(coordinator.syncVaultKeys).toHaveBeenCalled();
		expect(coordinator.refreshFromServer).toHaveBeenCalled();
	});

	it("preserves enabled state when sync metadata omits enabled", async () => {
		const { storage, itemCache } = await createLayers({
			travelModeCache: { enabled: true, hiddenVaultIds: ["vault-1"] },
		});

		const coordinator = {
			purgeHiddenVaultsForAccount: mock(() => undefined),
			syncVaultKeys: mock(async () => undefined),
			refreshFromServer: mock(async () => undefined),
		} as unknown as VaultRepository;

		const enforcer = getTravelModeEnforcer(storage, itemCache, coordinator);
		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: true,
			hiddenVaultIds: ["vault-1"],
			enabledAt: Date.now(),
			updatedAt: Date.now(),
		});
		(
			coordinator.purgeHiddenVaultsForAccount as ReturnType<typeof mock>
		).mockClear();

		await handleTravelModeSyncEvent(
			{
				type: "travel_mode_updated",
				metadata: {
					hiddenVaultIds: ["vault-2"],
				},
			},
			ACCOUNT_ID,
			storage,
			itemCache,
			coordinator,
		);

		expect(coordinator.purgeHiddenVaultsForAccount).toHaveBeenLastCalledWith(
			ACCOUNT_ID,
			["vault-2"],
		);
		expect(enforcer.getConfig(ACCOUNT_ID).enabled).toBe(true);
	});
});
