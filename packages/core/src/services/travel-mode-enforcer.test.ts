import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cachedItem } from "@bittery/shared/testing/item-fixtures";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type { CachedVaultMetadata } from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
} from "../testing/account-store-harness";
import { NO_CREDENTIAL_MIRROR } from "./account-lifecycle";
import {
	resetTravelModeEnforcerForTests,
	TravelModeEnforcer,
} from "./travel-mode-enforcer";
import type { VaultRepository } from "./vault-repository";

const ACCOUNT_ID = "acc-1";

/**
 * A real `AccountStore` plus a real `ItemCache`, seeded with one vault key, one cached
 * item and one cached vault — all belonging to vault `v1`, the vault every test below
 * hides. The purge assertions below check what actually ended up in storage rather than
 * which stub was called.
 */
async function createLayers(
	options: {
		travelModeCache?: { enabled: boolean; hiddenVaultIds: string[] } | null;
	} = {},
): Promise<{ storage: AccountStore; itemCache: ItemCache }> {
	const { store } = await createTestAccountStore();
	const { cache } = await createTestItemCache();

	await store.addAccount(accountMetadata({ accountId: ACCOUNT_ID }));
	await store.storeVaultKeys(
		[
			{
				vaultId: "v1",
				vaultName: "V1",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "encrypted",
				role: "owner",
			},
		],
		ACCOUNT_ID,
	);
	if (options.travelModeCache) {
		await store.storeTravelModeCache(options.travelModeCache, ACCOUNT_ID);
	}

	await cache.setCachedItems(
		[cachedItem({ id: "i1", vaultId: "v1" })],
		ACCOUNT_ID,
	);
	await cache.setCachedVaults(
		[{ id: "v1", name: "V1" } as CachedVaultMetadata],
		ACCOUNT_ID,
	);

	return { storage: store, itemCache: cache };
}

describe("TravelModeEnforcer", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("enable purges every layer, including the record cache", async () => {
		const { storage, itemCache } = await createLayers();
		const repository = {
			purgeHiddenVaultsForAccount: mock(() => {}),
		} as unknown as VaultRepository;

		const enforcer = new TravelModeEnforcer({
			storage,
			itemCache,
			repository,
		});

		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: true,
			hiddenVaultIds: ["v1"],
		});

		expect(repository.purgeHiddenVaultsForAccount).toHaveBeenCalledWith(
			ACCOUNT_ID,
			["v1"],
		);
		expect(await storage.getVaultKeys(ACCOUNT_ID)).toEqual([]);
		// The cache is the layer `AccountStore` cannot reach.
		expect(await itemCache.getCachedItems(ACCOUNT_ID)).toEqual([]);
		expect(await itemCache.getCachedVaults(ACCOUNT_ID)).toEqual([]);
		expect(enforcer.isEnabled(ACCOUNT_ID)).toBe(true);
	});

	it("disable transitions from enabled to disabled", async () => {
		const { storage, itemCache } = await createLayers();
		const enforcer = new TravelModeEnforcer({ storage, itemCache });

		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: true,
			hiddenVaultIds: ["v1"],
		});
		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: false,
			hiddenVaultIds: [],
		});

		expect(enforcer.isEnabled(ACCOUNT_ID)).toBe(false);
	});

	it("restores a verified cached policy while offline", async () => {
		const cached = { enabled: true, hiddenVaultIds: ["v1"] };
		const { storage, itemCache } = await createLayers({
			travelModeCache: cached,
		});
		const enforcer = new TravelModeEnforcer({ storage, itemCache });

		const config = await enforcer.verifyForUnlock(ACCOUNT_ID);

		expect(config).toEqual(cached);
		expect(enforcer.isVerified(ACCOUNT_ID)).toBe(true);
		expect(await storage.getVaultKeys(ACCOUNT_ID)).toEqual([]);
	});

	it("fails closed while offline when no cached policy exists", async () => {
		const { storage, itemCache } = await createLayers();
		const enforcer = new TravelModeEnforcer({ storage, itemCache });

		await expect(enforcer.verifyForUnlock(ACCOUNT_ID)).rejects.toThrow(
			"No verified travel mode policy",
		);
		expect(enforcer.isVerified(ACCOUNT_ID)).toBe(false);
	});

	it("replaces stale cached policy with verified server state", async () => {
		const { storage, itemCache } = await createLayers({
			travelModeCache: { enabled: false, hiddenVaultIds: [] },
		});
		const enforcer = new TravelModeEnforcer({ storage, itemCache });
		const apiClient = {
			travelMode: {
				get: mock(async () => ({
					data: {
						enabled: true,
						hiddenVaultIds: ["v1"],
						enabledAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				})),
			},
		} as never;

		const config = await enforcer.verifyForUnlock(ACCOUNT_ID, apiClient);

		expect(config.enabled).toBe(true);
		expect(config.hiddenVaultIds).toEqual(["v1"]);
		expect(await storage.getTravelModeCache(ACCOUNT_ID)).toMatchObject({
			enabled: true,
			hiddenVaultIds: ["v1"],
		});
	});

	it("verifyOrClear reports success without touching the session", async () => {
		const { storage, itemCache } = await createLayers({
			travelModeCache: { enabled: false, hiddenVaultIds: [] },
		});
		const clearSession = spyOn(storage, "clearSession");
		const enforcer = new TravelModeEnforcer({ storage, itemCache });

		expect(
			await enforcer.verifyOrClear(ACCOUNT_ID, undefined, NO_CREDENTIAL_MIRROR),
		).toBe(true);
		expect(clearSession).not.toHaveBeenCalled();
		expect(enforcer.isVerified(ACCOUNT_ID)).toBe(true);
	});

	it("verifyOrClear fails closed by clearing the session", async () => {
		const { storage, itemCache } = await createLayers();
		const events: string[] = [];
		const originalClearSession = storage.clearSession.bind(storage);
		const clearSession = spyOn(storage, "clearSession").mockImplementation(
			async (accountId) => {
				events.push("clear-session");
				await originalClearSession(accountId);
			},
		);
		const purge = mock(async () => {
			events.push("purge-mirror");
		});
		const enforcer = new TravelModeEnforcer({ storage, itemCache });

		expect(await enforcer.verifyOrClear(ACCOUNT_ID, undefined, { purge })).toBe(
			false,
		);
		expect(purge).toHaveBeenCalledWith([
			expect.objectContaining({ accountId: ACCOUNT_ID }),
		]);
		expect(events).toEqual(["purge-mirror", "clear-session"]);
		expect(clearSession).toHaveBeenCalledWith(ACCOUNT_ID);
		expect(enforcer.isVerified(ACCOUNT_ID)).toBe(false);
	});

	it("purges hidden data before committing an enabled policy", async () => {
		const { storage, itemCache } = await createLayers();
		const events: string[] = [];
		spyOn(storage, "storeVaultKeys").mockImplementation(async () => {
			events.push("purge:vault-keys");
		});
		spyOn(storage, "storeTravelModeCache").mockImplementation(async () => {
			events.push("persist:config");
		});
		const enforcer = new TravelModeEnforcer({ storage, itemCache });

		await enforcer.applyConfig(ACCOUNT_ID, {
			enabled: true,
			hiddenVaultIds: ["v1"],
		});

		expect(events).toEqual(["purge:vault-keys", "persist:config"]);
	});
});
