import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { TravelModeConfig } from "@bittery/storage/types";
import {
	resetTravelModeEnforcerForTests,
	TravelModeEnforcer,
} from "./travel-mode-enforcer";
import type { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

function createMockStorage(
	initialTravelConfig: TravelModeConfig | null = null,
	events: string[] = [],
): IStorageAdapter {
	let travelConfig: TravelModeConfig | null = initialTravelConfig;
	let vaultKeys = [{ vaultId: "v1", vaultName: "V1" }] as never[];
	let items = [{ id: "i1", vaultId: "v1" }] as never[];
	let vaults = [{ id: "v1", name: "V1" }] as never[];

	return {
		platform: "desktop",
		supportsMultiAccount: true,
		supportsBiometric: false,
		supportsItemCache: true,
		initialize: mock(async () => {}),
		getMasterUnlockKey: mock(async () => null),
		setMasterUnlockKey: mock(async () => {}),
		clearMasterUnlockKey: mock(async () => {}),
		storeSessionData: mock(async () => {}),
		tryRestoreSession: mock(async () => false),
		isSessionValid: mock(async () => false),
		storeSecretKey: mock(async () => {}),
		getStoredSecretKey: mock(async () => null),
		storeAuthToken: mock(async () => {}),
		getAuthToken: mock(async () => null),
		storeVaultKeys: mock(async (keys: unknown) => {
			events.push("purge:vault-keys");
			vaultKeys = keys as never[];
		}),
		getVaultKeys: mock(async () => vaultKeys),
		storeEncryptedPrivateKey: mock(async () => {}),
		getEncryptedPrivateKey: mock(async () => null),
		storePinnedKdfParams: mock(async () => {}),
		getPinnedKdfParams: mock(async () => null),
		getActiveAccount: mock(async () => null),
		getActiveAccountUserId: mock(async () => null),
		setActiveAccount: mock(async () => {}),
		getAccountsList: mock(async () => []),
		addAccount: mock(async () => {}),
		removeAccount: mock(async () => {}),
		storeAutoLockTimeout: mock(async () => {}),
		getAutoLockTimeout: mock(async () => null),
		getAutoLockTimeoutOrDefault: mock(async () => 600_000),
		storeServerUrl: mock(async () => {}),
		getServerUrl: mock(async () => null),
		isAuthenticated: mock(async () => false),
		canQuickUnlock: mock(async () => false),
		clearSession: mock(async () => {}),
		clearAllStoredData: mock(async () => {}),
		setCachedItems: mock(async (nextItems: unknown) => {
			items = nextItems as never[];
		}),
		getCachedItems: mock(async () => items),
		setCachedVaults: mock(async (nextVaults: unknown) => {
			vaults = nextVaults as never[];
		}),
		getCachedVaults: mock(async () => vaults),
		storeTravelModeCache: mock(async (config: TravelModeConfig) => {
			events.push("persist:config");
			travelConfig = config;
		}),
		getTravelModeCache: mock(async () => travelConfig),
	} as IStorageAdapter;
}

describe("TravelModeEnforcer", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("enable purges storage and coordinator layers", async () => {
		const storage = createMockStorage();
		const coordinator = {
			purgeHiddenVaultsForAccount: mock(() => {}),
		} as unknown as VaultRepositoryCoordinator;

		const enforcer = new TravelModeEnforcer({ storage, coordinator });

		await enforcer.applyConfig("acc-1", {
			enabled: true,
			hiddenVaultIds: ["v1"],
		});

		expect(coordinator.purgeHiddenVaultsForAccount).toHaveBeenCalledWith(
			"acc-1",
			["v1"],
		);
		expect(storage.storeVaultKeys).toHaveBeenCalled();
		expect(enforcer.isEnabled("acc-1")).toBe(true);
	});

	it("disable transitions from enabled to disabled", async () => {
		const storage = createMockStorage();
		const enforcer = new TravelModeEnforcer({ storage });

		await enforcer.applyConfig("acc-1", {
			enabled: true,
			hiddenVaultIds: ["v1"],
		});
		await enforcer.applyConfig("acc-1", {
			enabled: false,
			hiddenVaultIds: [],
		});

		expect(enforcer.isEnabled("acc-1")).toBe(false);
	});

	it("restores a verified cached policy while offline", async () => {
		const cached = { enabled: true, hiddenVaultIds: ["v1"] };
		const storage = createMockStorage(cached);
		const enforcer = new TravelModeEnforcer({ storage });

		const config = await enforcer.verifyForUnlock("acc-1");

		expect(config).toEqual(cached);
		expect(enforcer.isVerified("acc-1")).toBe(true);
		expect(storage.storeVaultKeys).toHaveBeenCalled();
	});

	it("fails closed while offline when no cached policy exists", async () => {
		const storage = createMockStorage();
		const enforcer = new TravelModeEnforcer({ storage });

		await expect(enforcer.verifyForUnlock("acc-1")).rejects.toThrow(
			"No verified travel mode policy",
		);
		expect(enforcer.isVerified("acc-1")).toBe(false);
	});

	it("replaces stale cached policy with verified server state", async () => {
		const storage = createMockStorage({ enabled: false, hiddenVaultIds: [] });
		const enforcer = new TravelModeEnforcer({ storage });
		const rpcClient = {
			travelMode: {
				getTravelMode: {
					query: mock(async () => ({
						enabled: true,
						hiddenVaultIds: ["v1"],
						enabledAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					})),
				},
			},
		} as never;

		const config = await enforcer.verifyForUnlock("acc-1", rpcClient);

		expect(config.enabled).toBe(true);
		expect(config.hiddenVaultIds).toEqual(["v1"]);
		expect(storage.storeTravelModeCache).toHaveBeenCalled();
	});

	it("purges hidden data before committing an enabled policy", async () => {
		const events: string[] = [];
		const storage = createMockStorage(null, events);
		const enforcer = new TravelModeEnforcer({ storage });

		await enforcer.applyConfig("acc-1", {
			enabled: true,
			hiddenVaultIds: ["v1"],
		});

		expect(events.indexOf("purge:vault-keys")).toBeLessThan(
			events.indexOf("persist:config"),
		);
	});
});
