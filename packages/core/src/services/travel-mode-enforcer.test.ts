import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { TravelModeConfig } from "@bittery/storage/types";
import {
	resetTravelModeEnforcerForTests,
	TravelModeEnforcer,
} from "./travel-mode-enforcer";
import type { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

function createMockStorage(): IStorageAdapter {
	let travelConfig: TravelModeConfig | null = null;
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
});
