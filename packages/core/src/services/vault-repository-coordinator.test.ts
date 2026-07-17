import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { AccountInfo } from "./account-resolver";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

function createMockStorage(): IStorageAdapter {
	const cachedItemsByAccount = new Map<string, unknown[]>();
	const cachedVaultsByAccount = new Map<string, unknown[]>();

	return {
		platform: "desktop",
		supportsMultiAccount: true,
		supportsBiometric: false,
		supportsItemCache: true,
		getServerUrl: mock(async () => null),
		getVaultKeys: mock(async () => []),
		storeVaultKeys: mock(async () => {}),
		getCachedItems: mock(
			async (accountId?: string) =>
				cachedItemsByAccount.get(accountId ?? "") ?? [],
		),
		setCachedItems: mock(async (items: unknown[], accountId?: string) => {
			cachedItemsByAccount.set(accountId ?? "", items);
		}),
		upsertCachedItem: mock(async (item: unknown, accountId?: string) => {
			const list = cachedItemsByAccount.get(accountId ?? "") ?? [];
			list.push(item);
			cachedItemsByAccount.set(accountId ?? "", list);
		}),
		getCachedVaults: mock(
			async (accountId?: string) =>
				cachedVaultsByAccount.get(accountId ?? "") ?? [],
		),
		setCachedVaults: mock(async (vaults: unknown[], accountId?: string) => {
			cachedVaultsByAccount.set(accountId ?? "", vaults);
		}),
		upsertCachedVault: mock(async (vault: unknown, accountId?: string) => {
			const list = cachedVaultsByAccount.get(accountId ?? "") ?? [];
			list.push(vault);
			cachedVaultsByAccount.set(accountId ?? "", list);
		}),
		getItemCacheMetadata: mock(async () => ({
			lastFullSyncAt: Date.now(),
			itemCount: 0,
			cacheVersion: 1,
		})),
		setItemCacheMetadata: mock(async () => {}),
		storeTravelModeCache: mock(async () => {}),
		getTravelModeCache: mock(async () => null),
	} as unknown as IStorageAdapter;
}

function makeTravelModeClient(hiddenVaultIds: string[] = []) {
	return {
		getTravelMode: {
			query: mock(async () => ({
				enabled: hiddenVaultIds.length > 0,
				hiddenVaultIds,
				enabledAt: null,
				updatedAt: new Date(0).toISOString(),
			})),
		},
	};
}

function makeAccountInfo(
	accountId: string,
	email: string,
	serverUrl: string,
	travelMode?: ReturnType<typeof makeTravelModeClient>,
): AccountInfo {
	return {
		accountId,
		email,
		userId: `${accountId}-user`,
		name: accountId,
		serverUrl,
		rpcClient: {
			sync: {
				bootstrapItems: {
					query: mock(async () => ({
						items: [],
						hasMore: false,
						nextCursor: null,
					})),
				},
			},
			vault: { list: { query: mock(async () => []) } },
			...(travelMode ? { travelMode } : {}),
		} as never,
	} as unknown as AccountInfo;
}

const crypto = {} as never;

describe("VaultRepositoryCoordinator", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	describe("M5 — findAccount resolution with shared email across servers", () => {
		it("findAccountForVault returns the repo that actually holds the vault, not the first email match", async () => {
			const storage = createMockStorage();
			const enforcer = getTravelModeEnforcer(storage);
			// Both accounts verified with travel mode disabled so reads are visible.
			await enforcer.applyConfig("acc-a", {
				enabled: false,
				hiddenVaultIds: [],
			});
			await enforcer.applyConfig("acc-b", {
				enabled: false,
				hiddenVaultIds: [],
			});

			const coordinator = new VaultRepositoryCoordinator(crypto, storage);
			const accountA = makeAccountInfo(
				"acc-a",
				"shared@example.com",
				"https://a.example.com",
			);
			const accountB = makeAccountInfo(
				"acc-b",
				"shared@example.com",
				"https://b.example.com",
			);
			// acc-a registered first, so a naive email .find() would resolve to it.
			coordinator.setActiveAccounts([accountA, accountB]);

			// Seed the vault ONLY into acc-b's repo.
			await coordinator.upsertVault(
				{
					id: "vault-1",
					name: "Vault 1",
					type: "personal",
					icon: null,
					imageUrl: null,
					accountEmail: "shared@example.com",
				} as never,
				"acc-b",
			);

			const located = coordinator.findAccountForVault("vault-1");
			expect(located?.accountId).toBe("acc-b");
		});

		it("findAccountForItem returns the repo that actually holds the item, not the first email match", async () => {
			const storage = createMockStorage();
			const enforcer = getTravelModeEnforcer(storage);
			await enforcer.applyConfig("acc-a", {
				enabled: false,
				hiddenVaultIds: [],
			});
			await enforcer.applyConfig("acc-b", {
				enabled: false,
				hiddenVaultIds: [],
			});

			const coordinator = new VaultRepositoryCoordinator(crypto, storage);
			const accountA = makeAccountInfo(
				"acc-a",
				"shared@example.com",
				"https://a.example.com",
			);
			const accountB = makeAccountInfo(
				"acc-b",
				"shared@example.com",
				"https://b.example.com",
			);
			coordinator.setActiveAccounts([accountA, accountB]);

			// Seed a decrypted item directly into acc-b's repo (no crypto needed).
			const repoB = coordinator.getOrCreate(
				"acc-b",
				"https://b.example.com",
				"shared@example.com",
			);
			await repoB.upsertLocal(
				{
					id: "item-1",
					vaultId: "vault-1",
					category: "login",
					favorite: false,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					title: "Example",
				} as never,
				{ ciphertext: "c", iv: "i", algorithm: "a" },
			);

			const located = coordinator.findAccountForItem("item-1");
			expect(located?.accountId).toBe("acc-b");
		});
	});

	describe("M4 — hydrate isolates per-account failures", () => {
		it("one unverified account does not abort hydration of the others", async () => {
			const storage = createMockStorage();
			const enforcer = getTravelModeEnforcer(storage);
			// Only acc-verified has a verified policy; acc-unverified will throw
			// from assertVerified inside repo.hydrate().
			await enforcer.applyConfig("acc-verified", {
				enabled: false,
				hiddenVaultIds: [],
			});

			const coordinator = new VaultRepositoryCoordinator(crypto, storage);
			const verified = makeAccountInfo(
				"acc-verified",
				"verified@example.com",
				"https://verified.example.com",
			);
			const unverified = makeAccountInfo(
				"acc-unverified",
				"unverified@example.com",
				"https://unverified.example.com",
			);

			// Must resolve (not reject) despite the unverified account throwing.
			await expect(
				coordinator.hydrate([verified, unverified]),
			).resolves.toBeUndefined();

			const verifiedRepo = coordinator.getRepositoryForAccount("acc-verified");
			const unverifiedRepo =
				coordinator.getRepositoryForAccount("acc-unverified");
			expect(verifiedRepo.isHydrated()).toBe(true);
			expect(unverifiedRepo.isHydrated()).toBe(false);
		});

		it("verifies travel mode against the server when the in-memory policy was lost", async () => {
			// Reproduces a web page reload: the session is still unlocked in
			// storage, but the enforcer's in-memory verification is gone because
			// nothing re-ran the unlock flow. Hydrate must re-verify rather than
			// fail closed on a perfectly valid session.
			const storage = createMockStorage();
			const travelMode = makeTravelModeClient();
			const coordinator = new VaultRepositoryCoordinator(crypto, storage);
			const account = makeAccountInfo(
				"acc-reloaded",
				"reloaded@example.com",
				"https://reloaded.example.com",
				travelMode,
			);

			await coordinator.hydrate([account]);

			expect(travelMode.getTravelMode.query).toHaveBeenCalled();
			expect(getTravelModeEnforcer(storage).isVerified("acc-reloaded")).toBe(
				true,
			);
			expect(
				coordinator.getRepositoryForAccount("acc-reloaded").isHydrated(),
			).toBe(true);
		});

		it("verifies each account only once across concurrent hydrate calls", async () => {
			const storage = createMockStorage();
			const travelMode = makeTravelModeClient();
			const coordinator = new VaultRepositoryCoordinator(crypto, storage);
			const account = makeAccountInfo(
				"acc-once",
				"once@example.com",
				"https://once.example.com",
				travelMode,
			);

			await Promise.all([
				coordinator.hydrate([account]),
				coordinator.hydrate([account]),
			]);

			expect(travelMode.getTravelMode.query).toHaveBeenCalledTimes(1);
		});
	});
});
