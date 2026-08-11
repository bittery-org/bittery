import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	seedAccountWithSession,
} from "../testing/account-store-harness";
import {
	AccountSessionManager,
	getAccountSessionManager,
	peekAccountSessionManager,
	resetAccountSessionManagerForTests,
} from "./account-session-manager";

/**
 * A real `AccountStore` over the in-memory platform port, seeded with two accounts:
 * `acc-1` active and unlocked, `acc-2` locked but quick-unlockable.
 */
async function createStore(
	opts: { unlockAcc2?: boolean } = {},
): Promise<AccountStore> {
	const harness = await createTestAccountStore();
	const { store } = harness;
	await seedAccountWithSession(
		harness,
		accountMetadata({ accountId: "acc-1" }),
	);
	await seedAccountWithSession(
		harness,
		accountMetadata({ accountId: "acc-2", addedAt: 2, lastActiveAt: 2 }),
		{ unlocked: opts.unlockAcc2 ?? false },
	);
	await store.setActiveAccount("acc-1");
	return store;
}

/**
 * A real `ItemCache` over the in-memory record port. Every manager below takes one:
 * `removeAccount` has to wipe the removed account's cached ciphertext, and
 * `AccountStore` cannot reach it.
 */
let itemCache: ItemCache;

describe("AccountSessionManager", () => {
	beforeEach(async () => {
		resetAccountSessionManagerForTests();
		itemCache = (await createTestItemCache()).cache;
	});

	it("removeAccount clears the removed account's encrypted item cache", async () => {
		const storage = await createStore();
		await itemCache.setCachedItems(
			[{ id: "item-1", vaultId: "vault-1" } as never],
			"acc-1",
		);
		await itemCache.setCachedItems(
			[{ id: "item-2", vaultId: "vault-2" } as never],
			"acc-2",
		);

		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});
		await manager.initialize();
		await manager.removeAccount("acc-1");

		// Cold again for the removed account, untouched for the other one: leaving
		// encrypted items behind after removal is the leak packages/storage/CONTEXT.md §4.2 names.
		expect(await itemCache.getCachedItems("acc-1")).toBeNull();
		expect(await itemCache.getCachedItems("acc-2")).toHaveLength(1);
	});

	it("switching A to B leaves A unlocked", async () => {
		const storage = await createStore();
		const clearSession = spyOn(storage, "clearSession");
		const setActiveAccount = spyOn(storage, "setActiveAccount");
		const onActiveChanged = mock(async () => {});
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			onActiveChanged,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.switchAccount("acc-2");

		expect(clearSession).not.toHaveBeenCalled();
		expect(setActiveAccount).toHaveBeenCalledWith("acc-2");
		expect(onActiveChanged).toHaveBeenCalledWith("acc-2");
		expect(manager.getActiveAccount()).toEqual("acc-2");
		expect(manager.isUnlocked("acc-1")).toBe(true);
		expect(manager.isUnlocked("acc-2")).toBe(true);
	});

	it("switching to an already-unlocked account does not restore it again", async () => {
		const storage = await createStore({ unlockAcc2: true });
		const tryRestoreSession = spyOn(storage, "tryRestoreSession");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.switchAccount("acc-2");

		expect(tryRestoreSession).not.toHaveBeenCalled();
		expect(manager.getUnlockedAccountIds().sort()).toEqual(["acc-1", "acc-2"]);
	});

	it("switching to a locked account restores only the target", async () => {
		const storage = await createStore();
		const tryRestoreSession = spyOn(storage, "tryRestoreSession");
		const clearSession = spyOn(storage, "clearSession");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.switchAccount("acc-2");

		expect(tryRestoreSession).toHaveBeenCalledWith(true, "acc-2");
		expect(tryRestoreSession).toHaveBeenCalledTimes(1);
		expect(clearSession).not.toHaveBeenCalled();
		expect(manager.isUnlocked("acc-1")).toBe(true);
		expect(manager.isUnlocked("acc-2")).toBe(true);
	});

	it("lockAll clears unlocked state for all accounts", async () => {
		const storage = await createStore({ unlockAcc2: true });
		const lockAllAccounts = spyOn(storage, "lockAllAccounts");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.lockAll("manual");

		expect(lockAllAccounts).toHaveBeenCalled();
		expect(manager.getUnlockedAccountIds()).toEqual([]);
		expect(await storage.getUnlockedAccounts()).toEqual([]);
	});

	it("lockAll broadcasts the reason only after storage is locked", async () => {
		const storage = await createStore({ unlockAcc2: true });
		const order: string[] = [];
		spyOn(storage, "lockAllAccounts").mockImplementation(async () => {
			order.push("storage");
		});
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			// A listener that unlocks again on the broadcast must find the locked
			// state already committed, so the order is part of the contract.
			onLockBroadcast: async (reason) => {
				order.push(`broadcast:${reason}`);
			},
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.lockAll("autolock");

		expect(order).toEqual(["storage", "broadcast:autolock"]);
	});

	it("removeAccount switches to remaining account when active is removed", async () => {
		const storage = await createStore();
		const clearAllStoredData = spyOn(storage, "clearAllStoredData");
		const setActiveAccount = spyOn(storage, "setActiveAccount");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		const outcome = await manager.removeAccount("acc-1");

		expect(clearAllStoredData).toHaveBeenCalledWith("acc-1");
		// The successor is written once, and never a `null` on the way there: the
		// pointer must not be observable as empty while accounts remain.
		expect(setActiveAccount).toHaveBeenCalledTimes(1);
		expect(setActiveAccount).toHaveBeenCalledWith("acc-2");
		expect(manager.getActiveAccount()).toEqual("acc-2");
		expect(outcome.failures).toEqual([]);
		expect(outcome.wasActive).toBe(true);
		expect(outcome.remaining.map((account) => account.accountId)).toEqual([
			"acc-2",
		]);
	});

	it("removeAccount leaves in-memory state consistent with storage", async () => {
		const storage = await createStore({ unlockAcc2: true });
		const onActiveChanged = mock(async () => {});
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			onActiveChanged,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.removeAccount("acc-1");

		expect(manager.getAccounts().map((account) => account.accountId)).toEqual(
			(await storage.getAccountsList()).map((account) => account.accountId),
		);
		expect(manager.getUnlockedAccountIds().sort()).toEqual(
			(await storage.getUnlockedAccounts()).sort(),
		);
		expect(manager.isUnlocked("acc-1")).toBe(false);
		expect(onActiveChanged).toHaveBeenCalledTimes(1);
		expect(onActiveChanged).toHaveBeenCalledWith("acc-2");
	});

	it("removeAccount purges the injected credential mirror", async () => {
		const storage = await createStore();
		const purge = mock(async () => {});
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			credentialMirror: { purge },
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.removeAccount("acc-1");

		// Snapshotted before the account row goes: a mirror keyed by a token we
		// already dropped can no longer be found.
		expect(purge).toHaveBeenCalledWith([
			{ accountId: "acc-1", authToken: "token-acc-1", serverUrl: null },
		]);
	});

	it("removing the only active account persists null", async () => {
		const storage = await createStore();
		await storage.removeAccount("acc-2");
		const setActiveAccount = spyOn(storage, "setActiveAccount");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.removeAccount("acc-1");

		// Clearing the last account's data drops the pointer itself, so there is no
		// successor to promote and nothing to write.
		expect(setActiveAccount).not.toHaveBeenCalled();
		expect(await storage.getActiveAccount()).toBeNull();
		expect(manager.getActiveAccount()).toBeNull();
	});

	it("reconstruction after final-account removal does not restore a stale ID", async () => {
		const storage = await createStore();
		await storage.removeAccount("acc-2");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});
		await manager.initialize();
		await manager.removeAccount("acc-1");

		const reconstructed = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});
		await reconstructed.initialize();

		expect(reconstructed.getAccounts()).toEqual([]);
		expect(reconstructed.getActiveAccount()).toBeNull();
	});

	it("removing a non-active account does not alter the active account", async () => {
		const storage = await createStore();
		const setActiveAccount = spyOn(storage, "setActiveAccount");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.removeAccount("acc-2");

		expect(setActiveAccount).not.toHaveBeenCalled();
		expect(manager.getActiveAccount()).toEqual("acc-1");
	});

	it("treats a stored active accountId that matches no account as null", async () => {
		// A corrupted pointer can still look like an id, so refresh must validate
		// it against the account list.
		const storage = await createStore();
		await storage.setActiveAccount("a@test.com");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();

		expect(manager.getActiveAccount()).toBeNull();
		expect(manager.getActiveAccountMetadata()).toBeNull();
	});

	it("keeps a stored active accountId that matches a known account", async () => {
		const storage = await createStore();
		await storage.setActiveAccount("acc-2");
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();

		expect(manager.getActiveAccount()).toEqual("acc-2");
	});

	it("clears a restored session when travel mode cannot be verified", async () => {
		const storage = await createStore();
		const clearSession = spyOn(storage, "clearSession");
		const purge = mock(async () => {});
		const manager = new AccountSessionManager({
			storage,
			itemCache,
			credentialMirror: { purge },
			verifyUnlockPolicy: async () => {
				throw new Error("policy unavailable");
			},
		});

		await manager.initialize();
		const restored = await manager.unlockAccount("acc-2", true);

		expect(restored).toBe(false);
		expect(purge).toHaveBeenCalledWith([
			expect.objectContaining({ accountId: "acc-2" }),
		]);
		expect(clearSession).toHaveBeenCalledWith("acc-2");
		expect(manager.isUnlocked("acc-2")).toBe(false);
	});
});

describe("getAccountSessionManager", () => {
	beforeEach(async () => {
		resetAccountSessionManagerForTests();
		itemCache = (await createTestItemCache()).cache;
	});

	it("rejects options once the manager exists, instead of dropping them", async () => {
		const storage = await createStore();
		getAccountSessionManager({ storage, itemCache });

		expect(() =>
			getAccountSessionManager({
				storage,
				itemCache,
				onActiveChanged: () => {},
			}),
		).toThrow(/already constructed/);
	});

	it("returns the same instance for option-less calls", async () => {
		const storage = await createStore();
		const manager = getAccountSessionManager({ storage, itemCache });

		expect(getAccountSessionManager()).toBe(manager);
		expect(peekAccountSessionManager()).toBe(manager);
	});

	it("peek returns null before construction, get throws", () => {
		expect(peekAccountSessionManager()).toBeNull();
		expect(() => getAccountSessionManager()).toThrow(/not initialized/);
	});
});
