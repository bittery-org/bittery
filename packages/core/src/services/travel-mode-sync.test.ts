import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { VaultKeyData } from "@bittery/storage/types";
import type { AccountResolver } from "./account-resolver";
import {
	getTravelModeService,
	resetTravelModeServiceForTests,
} from "./travel-mode-service";
import {
	handleTravelModeSyncEvent,
	restoreAfterTravelModeDisabled,
} from "./travel-mode-sync";
import type { VaultRepositoryCoordinator } from "./vault-repository-coordinator";
import type { RpcVaultClient } from "./vault-service";

describe("travel-mode-sync", () => {
	beforeEach(() => {
		resetTravelModeServiceForTests();
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

		const storage = {
			storeVaultKeys: mock(async () => undefined),
			getVaultKeys: mock(async () => vaultKeys),
			storeTravelModeCache: mock(async () => undefined),
			getTravelModeCache: mock(async () => ({
				enabled: false,
				hiddenVaultIds: ["vault-1"],
			})),
		} as unknown as IStorageAdapter;

		const rpcClient = {
			vault: {
				list: {
					query: mock(async () => [
						{
							id: "vault-1",
							name: "Private",
							vaultType: "personal",
							icon: null,
							imageUrl: null,
							encryptedVaultKey: "encrypted",
							role: "owner",
						},
					]),
				},
			},
		} as unknown as RpcVaultClient;

		const coordinator = {
			syncVaultKeys: mock(async () => undefined),
			refreshFromServer: mock(async () => undefined),
		} as unknown as VaultRepositoryCoordinator;

		const accounts = {
			resolveAccounts: mock(async () => ({
				accountsInfo: [
					{
						email: "user@example.com",
						rpcClient,
					},
				],
			})),
		} as unknown as AccountResolver;

		await restoreAfterTravelModeDisabled(
			"user@example.com",
			storage,
			coordinator,
			{ rpcClient, accounts },
		);

		expect(rpcClient.vault.list.query).toHaveBeenCalled();
		expect(storage.storeVaultKeys).toHaveBeenCalledWith(
			vaultKeys,
			"user@example.com",
		);
		expect(coordinator.syncVaultKeys).toHaveBeenCalledWith(
			vaultKeys,
			"user@example.com",
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

		const storage = {
			storeVaultKeys: mock(async () => undefined),
			getVaultKeys: mock(async () => vaultKeys),
			storeTravelModeCache: mock(async () => undefined),
			getTravelModeCache: mock(async () => ({
				enabled: true,
				hiddenVaultIds: ["vault-1"],
			})),
		} as unknown as IStorageAdapter;

		const rpcClient = {
			vault: {
				list: {
					query: mock(async () => [
						{
							id: "vault-1",
							name: "Private",
							vaultType: "personal",
							icon: null,
							imageUrl: null,
							encryptedVaultKey: "encrypted",
							role: "owner",
						},
					]),
				},
			},
		} as unknown as RpcVaultClient;

		const coordinator = {
			purgeHiddenVaultsForEmail: mock(() => undefined),
			syncVaultKeys: mock(async () => undefined),
			refreshFromServer: mock(async () => undefined),
		} as unknown as VaultRepositoryCoordinator;

		const accounts = {
			resolveAccounts: mock(async () => ({
				accountsInfo: [
					{
						email: "user@example.com",
						rpcClient,
					},
				],
			})),
		} as unknown as AccountResolver;

		const travelMode = getTravelModeService(storage);
		await travelMode.applyRemoteUpdate("user@example.com", {
			enabled: true,
			hiddenVaultIds: ["vault-1"],
			enabledAt: Date.now(),
			updatedAt: Date.now(),
		});

		await handleTravelModeSyncEvent(
			{
				type: "travel_mode_updated",
				metadata: {
					enabled: false,
					hiddenVaultIds: ["vault-1"],
				},
			},
			"user@example.com",
			storage,
			coordinator,
			{ rpcClient, accounts },
		);

		expect(coordinator.purgeHiddenVaultsForEmail).not.toHaveBeenCalled();
		expect(coordinator.syncVaultKeys).toHaveBeenCalled();
		expect(coordinator.refreshFromServer).toHaveBeenCalled();
	});

	it("preserves enabled state when sync metadata omits enabled", async () => {
		const storage = {
			storeVaultKeys: mock(async () => undefined),
			getVaultKeys: mock(async () => []),
			storeTravelModeCache: mock(async () => undefined),
			getTravelModeCache: mock(async () => ({
				enabled: true,
				hiddenVaultIds: ["vault-1"],
			})),
		} as unknown as IStorageAdapter;

		const coordinator = {
			purgeHiddenVaultsForEmail: mock(() => undefined),
			syncVaultKeys: mock(async () => undefined),
			refreshFromServer: mock(async () => undefined),
		} as unknown as VaultRepositoryCoordinator;

		const travelMode = getTravelModeService(storage);
		await travelMode.applyRemoteUpdate("user@example.com", {
			enabled: true,
			hiddenVaultIds: ["vault-1"],
			enabledAt: Date.now(),
			updatedAt: Date.now(),
		});

		await handleTravelModeSyncEvent(
			{
				type: "travel_mode_updated",
				metadata: {
					hiddenVaultIds: ["vault-2"],
				},
			},
			"user@example.com",
			storage,
			coordinator,
		);

		expect(coordinator.purgeHiddenVaultsForEmail).toHaveBeenCalledWith(
			"user@example.com",
			["vault-2"],
		);
		expect(travelMode.getConfig("user@example.com").enabled).toBe(true);
	});
});
