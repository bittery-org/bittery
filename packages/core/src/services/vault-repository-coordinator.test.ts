import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { InMemoryCryptoPort } from "@bittery/crypto-port/testing";
import type { AccountStore, ItemCache } from "@bittery/storage";
import {
	createTestAccountStore,
	createTestItemCache,
	mukRefFor,
} from "../testing/account-store-harness";
import type { AccountInfo } from "./account-resolver";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { createVaultCrypto, type VaultCrypto } from "./vault-crypto";
import { VaultRepositoryCoordinator } from "./vault-repository-coordinator";

/**
 * A real `AccountStore` and a real `ItemCache`, each over its own in-memory port. The
 * real pair gives the coordinator honest per-account isolation: `ItemCache` keys every
 * collection by accountId, which is exactly what these tests are about.
 */
async function createLayers(): Promise<{
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: InMemoryCryptoPort;
	vaultCrypto: VaultCrypto;
}> {
	const { store, crypto } = await createTestAccountStore();
	const { cache } = await createTestItemCache();
	return {
		storage: store,
		itemCache: cache,
		crypto,
		vaultCrypto: createVaultCrypto({ crypto, storage: store }),
	};
}

/** Repositories only hydrate unlocked accounts, so every hydrate test needs one. */
async function unlock(
	{ storage, crypto }: { storage: AccountStore; crypto: InMemoryCryptoPort },
	...accountIds: string[]
): Promise<void> {
	for (const accountId of accountIds) {
		await storage.setMasterUnlockKey(
			await mukRefFor(crypto, accountId),
			accountId,
		);
	}
}

function makeTravelModeClient(hiddenVaultIds: string[] = []) {
	return {
		get: mock(async () => ({
			data: {
				enabled: hiddenVaultIds.length > 0,
				hiddenVaultIds,
				enabledAt: null,
				updatedAt: new Date(0).toISOString(),
			},
		})),
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
		apiClient: {
			sync: {
				bootstrap: mock(async () => ({
					data: {
						items: [],
						hasMore: false,
						nextCursor: null,
					},
				})),
			},
			vaults: { list: mock(async () => ({ data: [] })) },
			...(travelMode ? { travelMode } : {}),
		} as never,
	} as unknown as AccountInfo;
}

describe("VaultRepositoryCoordinator", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	describe("M5 — findAccount resolution with shared email across servers", () => {
		it("findAccountForVault returns the repo that actually holds the vault, not the first email match", async () => {
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			const enforcer = getTravelModeEnforcer(storage, itemCache);
			// Both accounts verified with travel mode disabled so reads are visible.
			await enforcer.applyConfig("acc-a", {
				enabled: false,
				hiddenVaultIds: [],
			});
			await enforcer.applyConfig("acc-b", {
				enabled: false,
				hiddenVaultIds: [],
			});

			const coordinator = new VaultRepositoryCoordinator(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
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
			await coordinator.upsertCachedVault(
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
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			const enforcer = getTravelModeEnforcer(storage, itemCache);
			await enforcer.applyConfig("acc-a", {
				enabled: false,
				hiddenVaultIds: [],
			});
			await enforcer.applyConfig("acc-b", {
				enabled: false,
				hiddenVaultIds: [],
			});

			const coordinator = new VaultRepositoryCoordinator(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
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
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			await unlock({ storage, crypto }, "acc-verified", "acc-unverified");
			const enforcer = getTravelModeEnforcer(storage, itemCache);
			// Only acc-verified has a verified policy; acc-unverified will throw
			// from assertVerified inside repo.hydrate().
			await enforcer.applyConfig("acc-verified", {
				enabled: false,
				hiddenVaultIds: [],
			});

			const coordinator = new VaultRepositoryCoordinator(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
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
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			await unlock({ storage, crypto }, "acc-reloaded");
			const travelMode = makeTravelModeClient();
			const coordinator = new VaultRepositoryCoordinator(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
			const account = makeAccountInfo(
				"acc-reloaded",
				"reloaded@example.com",
				"https://reloaded.example.com",
				travelMode,
			);

			await coordinator.hydrate([account]);

			expect(travelMode.get).toHaveBeenCalled();
			expect(
				getTravelModeEnforcer(storage, itemCache).isVerified("acc-reloaded"),
			).toBe(true);
			expect(
				coordinator.getRepositoryForAccount("acc-reloaded").isHydrated(),
			).toBe(true);
		});

		it("verifies each account only once across concurrent hydrate calls", async () => {
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			const travelMode = makeTravelModeClient();
			const coordinator = new VaultRepositoryCoordinator(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
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

			expect(travelMode.get).toHaveBeenCalledTimes(1);
		});
	});
});
