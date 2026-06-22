import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { VaultKeyData } from "@bittery/storage/types";
import { describe, expect, it, vi } from "vitest";
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
	it("restores vault keys and refreshes coordinator after travel mode is disabled", async () => {
		const vaultKeys: VaultKeyData[] = [
			{
				vaultId: "vault-1",
				vaultName: "Private",
				vaultType: "personal",
				encryptedVaultKey: "encrypted",
				role: "owner",
			},
		];

		const storage = {
			storeVaultKeys: vi.fn().mockResolvedValue(undefined),
			getVaultKeys: vi.fn().mockResolvedValue(vaultKeys),
			storeTravelModeCache: vi.fn().mockResolvedValue(undefined),
			getTravelModeCache: vi.fn().mockResolvedValue({
				enabled: false,
				hiddenVaultIds: ["vault-1"],
			}),
		} as unknown as IStorageAdapter;

		const rpcClient = {
			vault: {
				list: {
					query: vi.fn().mockResolvedValue([
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
			syncVaultKeys: vi.fn().mockResolvedValue(undefined),
			refreshFromServer: vi.fn().mockResolvedValue(undefined),
		} as unknown as VaultRepositoryCoordinator;

		const accounts = {
			resolveAccounts: vi.fn().mockResolvedValue({
				accountsInfo: [
					{
						email: "user@example.com",
						rpcClient,
					},
				],
			}),
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
		resetTravelModeServiceForTests();

		const vaultKeys: VaultKeyData[] = [
			{
				vaultId: "vault-1",
				vaultName: "Private",
				vaultType: "personal",
				encryptedVaultKey: "encrypted",
				role: "owner",
			},
		];

		const storage = {
			storeVaultKeys: vi.fn().mockResolvedValue(undefined),
			getVaultKeys: vi.fn().mockResolvedValue(vaultKeys),
			storeTravelModeCache: vi.fn().mockResolvedValue(undefined),
			getTravelModeCache: vi.fn().mockResolvedValue({
				enabled: true,
				hiddenVaultIds: ["vault-1"],
			}),
		} as unknown as IStorageAdapter;

		const rpcClient = {
			vault: {
				list: {
					query: vi.fn().mockResolvedValue([
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
			purgeHiddenVaultsForEmail: vi.fn(),
			syncVaultKeys: vi.fn().mockResolvedValue(undefined),
			refreshFromServer: vi.fn().mockResolvedValue(undefined),
		} as unknown as VaultRepositoryCoordinator;

		const accounts = {
			resolveAccounts: vi.fn().mockResolvedValue({
				accountsInfo: [
					{
						email: "user@example.com",
						rpcClient,
					},
				],
			}),
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
});
