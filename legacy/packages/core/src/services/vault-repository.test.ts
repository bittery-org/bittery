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
import { VaultRepository } from "./vault-repository";

/**
 * A real `AccountStore` and a real `ItemCache`, each over its own in-memory port. The
 * real pair gives the repository honest per-account isolation: `ItemCache` keys every
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

describe("VaultRepository", () => {
	beforeEach(() => {
		resetTravelModeEnforcerForTests();
	});

	it("remembers unlocked non-active accounts without widening the active read scope", async () => {
		const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
		await unlock({ storage, crypto }, "acc-a", "acc-b");
		for (const accountId of ["acc-a", "acc-b"]) {
			await getTravelModeEnforcer(storage, itemCache).applyConfig(accountId, {
				enabled: false,
				hiddenVaultIds: [],
			});
		}
		const active = makeAccountInfo(
			"acc-a",
			"a@example.com",
			"https://a.example",
		);
		const unlocked = makeAccountInfo(
			"acc-b",
			"b@example.com",
			"https://b.example",
		);
		const repository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);
		repository.setLocalActiveAccounts([active]);
		await repository.hydrateRemoteAccounts([active, unlocked]);
		expect(repository.getAccountInfo("acc-b")).toMatchObject({
			accountId: "acc-b",
			email: "b@example.com",
		});
	});

	it("reloads a projection after another process changes the durable cache", async () => {
		const {
			storage,
			itemCache: durableCache,
			crypto,
			vaultCrypto,
		} = await createLayers();
		let cacheReadError: Error | null = null;
		const itemCache = new Proxy(durableCache, {
			get(target, property) {
				if (property === "getCachedItems") {
					return async (accountId: string) => {
						if (cacheReadError) throw cacheReadError;
						return target.getCachedItems(accountId);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await unlock({ storage, crypto }, "acc-a");
		await getTravelModeEnforcer(storage, itemCache).applyConfig("acc-a", {
			enabled: false,
			hiddenVaultIds: [],
		});
		const account = makeAccountInfo(
			"acc-a",
			"a@example.com",
			"https://a.example",
		);
		const repository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);
		repository.setLocalActiveAccounts([account]);
		await repository.hydrateLocalAccounts([account]);
		const workerRepository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);
		workerRepository.setLocalActiveAccounts([account]);
		await workerRepository.upsertCachedVault(
			{
				id: "worker-vault",
				name: "Written by worker",
				type: "personal",
				icon: null,
				imageUrl: null,
				accountId: "acc-a",
			} as never,
			"acc-a",
		);

		expect(repository.getVaultById("worker-vault", "acc-a")).toBeUndefined();
		await repository.hydrateLocalAccounts([account]);
		expect(repository.getVaultById("worker-vault", "acc-a")).toMatchObject({
			id: "worker-vault",
			name: "Written by worker",
		});
		cacheReadError = new Error("durable cache failed");
		await expect(repository.hydrateLocalAccounts([account])).rejects.toThrow(
			"durable cache failed",
		);
		expect(repository.getVaultById("worker-vault", "acc-a")).toBeUndefined();
		repository.setLocalActiveAccounts([]);
		expect(repository.getVaultById("worker-vault", "acc-a")).toBeUndefined();
		expect(repository.getAll()).toEqual([]);
	});

	it("runs an explicit refresh after a bootstrap that was already in flight", async () => {
		const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
		await unlock({ storage, crypto }, "acc-a");
		await getTravelModeEnforcer(storage, itemCache).applyConfig("acc-a", {
			enabled: false,
			hiddenVaultIds: [],
		});
		let releaseFirst: (() => void) | undefined;
		let bootstrapCalls = 0;
		const account = makeAccountInfo(
			"acc-a",
			"a@example.com",
			"https://a.example.com",
		);
		account.apiClient.sync.bootstrap = mock(async () => {
			bootstrapCalls += 1;
			if (bootstrapCalls === 1) {
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return {
				data: { items: [], hasMore: false, nextCursor: null },
			};
		}) as never;
		const repository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);

		const first = repository.refreshFromServer([account]);
		while (!releaseFirst) await Promise.resolve();
		const second = repository.refreshFromServer([account]);
		const third = repository.refreshFromServer([account]);
		expect(bootstrapCalls).toBe(1);

		releaseFirst();
		await Promise.all([first, second, third]);
		expect(bootstrapCalls).toBe(2);
	});

	it("serializes local opening with an authoritative server refresh", async () => {
		const {
			storage,
			itemCache: durableCache,
			crypto,
			vaultCrypto,
		} = await createLayers();
		let releaseLocal!: () => void;
		let localStarted!: () => void;
		const localGate = new Promise<void>((resolve) => {
			releaseLocal = resolve;
		});
		const enteredLocal = new Promise<void>((resolve) => {
			localStarted = resolve;
		});
		const order: string[] = [];
		let blockNextCacheRead = true;
		const itemCache = new Proxy(durableCache, {
			get(target, property) {
				if (property === "getCachedItems") {
					return async (accountId: string) => {
						if (blockNextCacheRead) {
							blockNextCacheRead = false;
							order.push("local:start");
							localStarted();
							await localGate;
							order.push("local:end");
						}
						return target.getCachedItems(accountId);
					};
				}
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		await unlock({ storage, crypto }, "acc-a");
		await getTravelModeEnforcer(storage, itemCache).applyConfig("acc-a", {
			enabled: false,
			hiddenVaultIds: [],
		});
		const account = makeAccountInfo(
			"acc-a",
			"a@example.com",
			"https://a.example.com",
		);
		account.apiClient.sync.bootstrap = mock(async () => {
			order.push("remote");
			return {
				data: { items: [], hasMore: false, nextCursor: null },
			};
		}) as never;
		const repository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);
		repository.setLocalActiveAccounts([account]);

		const local = repository.hydrateLocalAccounts([account]);
		await enteredLocal;
		const remote = repository.refreshFromServer([account]);
		await Promise.resolve();
		expect(order).toEqual(["local:start"]);
		releaseLocal();
		await Promise.all([local, remote]);
		expect(order).toEqual(["local:start", "local:end", "remote"]);
	});

	it("retries one failed initial server hydration", async () => {
		const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
		await unlock({ storage, crypto }, "acc-a");
		await getTravelModeEnforcer(storage, itemCache).applyConfig("acc-a", {
			enabled: false,
			hiddenVaultIds: [],
		});
		const account = makeAccountInfo(
			"acc-a",
			"a@example.com",
			"https://a.example.com",
		);
		let attempts = 0;
		account.apiClient.vaults.list = mock(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary network failure");
			return { data: [] };
		}) as never;
		const repository = new VaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		);

		await repository.hydrateRemoteAccounts([account]);

		expect(attempts).toBe(2);
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

			const repository = new VaultRepository(
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
			repository.setLocalActiveAccounts([accountA, accountB]);

			// Seed the vault ONLY into acc-b's repo.
			await repository.upsertCachedVault(
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

			const located = repository.findAccountForVault("vault-1");
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

			const repository = new VaultRepository(
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
			repository.setLocalActiveAccounts([accountA, accountB]);

			// Seed through the account-aware public repository boundary.
			await repository.upsertLocal(
				"acc-b",
				{
					id: "item-1",
					vaultId: "vault-1",
					category: "login",
					favorite: false,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					title: "Example",
				} as never,
				{
					ciphertext: "c",
					iv: "i",
					algorithm: "a",
					encryptionVersion: 1,
					encryptedByUserId: "user-b",
				},
			);

			const located = repository.findAccountForItem("item-1");
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

			const repository = new VaultRepository(
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
				repository.hydrateRemoteAccounts([verified, unverified]),
			).resolves.toBeUndefined();

			expect(repository.isAccountHydrated("acc-verified")).toBe(true);
			expect(repository.isAccountHydrated("acc-unverified")).toBe(false);
		});

		it("verifies travel mode against the server when the in-memory policy was lost", async () => {
			// Reproduces a web page reload: the session is still unlocked in
			// storage, but the enforcer's in-memory verification is gone because
			// nothing re-ran the unlock flow. Hydrate must re-verify rather than
			// fail closed on a perfectly valid session.
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			await unlock({ storage, crypto }, "acc-reloaded");
			const travelMode = makeTravelModeClient();
			const repository = new VaultRepository(
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

			await repository.hydrateRemoteAccounts([account]);

			expect(travelMode.get).toHaveBeenCalled();
			expect(
				getTravelModeEnforcer(storage, itemCache).isVerified("acc-reloaded"),
			).toBe(true);
			expect(repository.isAccountHydrated("acc-reloaded")).toBe(true);
		});

		it("verifies each account only once across concurrent hydrate calls", async () => {
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			const travelMode = makeTravelModeClient();
			const repository = new VaultRepository(
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
				repository.hydrateRemoteAccounts([account]),
				repository.hydrateRemoteAccounts([account]),
			]);

			expect(travelMode.get).toHaveBeenCalledTimes(1);
		});

		it("shares one bootstrap between UI hydration and sync initialization", async () => {
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			await unlock({ storage, crypto }, "acc-cold");
			const travelMode = makeTravelModeClient();
			const repository = new VaultRepository(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
			const account = makeAccountInfo(
				"acc-cold",
				"cold@example.com",
				"https://cold.example.com/",
				travelMode,
			);
			account.apiClient.sync.bootstrap = mock(async () => ({
				data: {
					items: [],
					hasMore: false,
					nextCursor: null,
					syncCursor: { id: "evt_bootstrap" },
				},
			})) as never;

			const [, baseline] = await Promise.all([
				repository.hydrateRemoteAccounts([account]),
				repository.initializeSyncBaseline([account], account.accountId),
			]);

			expect(account.apiClient.sync.bootstrap).toHaveBeenCalledTimes(1);
			expect(baseline).toEqual({ id: "evt_bootstrap" });
			expect(
				(await itemCache.getItemCacheMetadata(account.accountId))?.syncBaseline,
			).toEqual({
				serverUrl: "https://cold.example.com",
				cursorId: "evt_bootstrap",
			});
		});

		it("keeps a later cursor only while its cache generation still exists", async () => {
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			await unlock({ storage, crypto }, "acc-generation");
			const repository = new VaultRepository(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
			const account = makeAccountInfo(
				"acc-generation",
				"generation@example.com",
				"https://generation.example.com",
				makeTravelModeClient(),
			);
			let bootstrapCursor = "evt_bootstrap";
			account.apiClient.sync.bootstrap = mock(async () => ({
				data: {
					items: [],
					hasMore: false,
					nextCursor: null,
					syncCursor: { id: bootstrapCursor },
				},
			})) as never;

			expect(
				await repository.initializeSyncBaseline([account], account.accountId),
			).toEqual({ id: "evt_bootstrap" });
			expect(
				await repository.initializeSyncBaseline([account], account.accountId, {
					id: "evt_later",
				}),
			).toEqual({ id: "evt_later" });
			expect(account.apiClient.sync.bootstrap).toHaveBeenCalledTimes(1);

			await itemCache.clearItemCache(account.accountId);
			bootstrapCursor = "evt_after_fresh_login";
			expect(
				await repository.initializeSyncBaseline([account], account.accountId, {
					id: "evt_later",
				}),
			).toEqual({ id: "evt_after_fresh_login" });
			expect(account.apiClient.sync.bootstrap).toHaveBeenCalledTimes(2);
		});

		it("does not initialize a cursor before a locked account commits bootstrap", async () => {
			const { storage, itemCache, crypto, vaultCrypto } = await createLayers();
			const repository = new VaultRepository(
				crypto,
				vaultCrypto,
				storage,
				itemCache,
			);
			const account = makeAccountInfo(
				"acc-locked",
				"locked@example.com",
				"https://locked.example.com",
				makeTravelModeClient(),
			);

			await expect(
				repository.initializeSyncBaseline([account], account.accountId),
			).rejects.toThrow("did not commit a sync baseline");
			expect(account.apiClient.sync.bootstrap).not.toHaveBeenCalled();
			expect(
				(await itemCache.getItemCacheMetadata(account.accountId))?.syncBaseline,
			).toBeUndefined();
		});
	});
});
