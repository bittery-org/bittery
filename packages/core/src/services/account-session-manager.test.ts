import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	seedAccountWithSession,
} from "../testing/account-store-harness";
import type { AccountSessionManagerOptions } from "./account-session-manager";
import { ClientRuntime } from "./client-runtime";
import type { VaultRepository } from "./vault-repository";

function createManager(options: AccountSessionManagerOptions) {
	return new ClientRuntime({
		...options,
		vaultRepository: {} as VaultRepository,
	}).accounts;
}

/**
 * A real `AccountStore` over the in-memory platform port, seeded with two accounts:
 * `acc-1` active and unlocked, `acc-2` locked but quick-unlockable.
 */
async function createStore(
	opts: { unlockAcc1?: boolean; unlockAcc2?: boolean } = {},
): Promise<AccountStore> {
	const harness = await createTestAccountStore();
	const { store } = harness;
	await seedAccountWithSession(
		harness,
		accountMetadata({ accountId: "acc-1" }),
		{ unlocked: opts.unlockAcc1 ?? true },
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
		itemCache = (await createTestItemCache()).cache;
	});

	it("silently restores local Vault sessions without remote unlock verification", async () => {
		const storage = await createStore({ unlockAcc1: false });
		const restoreSession = spyOn(storage, "tryRestoreSessionWithoutPrompt");
		const verifyUnlockPolicy = mock(async () => {
			throw new Error("network must not be consulted");
		});
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy,
		});
		await manager.initializeLocalVaultState();
		expect(manager.getActiveAccount()).toBe("acc-1");
		expect(manager.getUnlockedAccountIds().sort()).toEqual(["acc-1", "acc-2"]);
		expect(restoreSession).toHaveBeenCalledWith("acc-1");
		expect(restoreSession).toHaveBeenCalledWith("acc-2");
		expect(verifyUnlockPolicy).not.toHaveBeenCalled();
	});

	it("verifies a silently restored account before treating unlock as idempotent", async () => {
		const storage = await createStore({ unlockAcc1: false });
		const verifyUnlockPolicy = mock(async () => {});
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy,
		});
		await manager.initializeLocalVaultState();

		expect(await manager.unlockAccount("acc-1", true)).toBe(true);
		expect(verifyUnlockPolicy).toHaveBeenCalledWith("acc-1");
	});

	it("shares local restoration with full verified initialization", async () => {
		const storage = await createStore({
			unlockAcc1: false,
			unlockAcc2: false,
		});
		const restore = spyOn(storage, "tryRestoreSessionWithoutPrompt");
		const verifyUnlockPolicy = mock(async () => {});
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy,
		});

		await Promise.all([
			manager.initializeLocalVaultState(),
			manager.initialize(),
		]);

		expect(restore).toHaveBeenCalledTimes(2);
		expect(verifyUnlockPolicy).toHaveBeenCalledTimes(2);
		expect(manager.isInitialized()).toBe(true);
		expect(manager.getUnlockedAccountIds().sort()).toEqual(["acc-1", "acc-2"]);
	});

	it("serializes a newer lock after delayed silent restoration", async () => {
		const storage = await createStore({
			unlockAcc1: false,
			unlockAcc2: false,
		});
		const originalRestore =
			storage.tryRestoreSessionWithoutPrompt.bind(storage);
		let restorationStarted!: () => void;
		let releaseRestoration!: () => void;
		const started = new Promise<void>((resolve) => {
			restorationStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			releaseRestoration = resolve;
		});
		spyOn(storage, "tryRestoreSessionWithoutPrompt").mockImplementation(
			async (accountId) => {
				if (accountId === "acc-1") {
					restorationStarted();
					await blocked;
				}
				return originalRestore(accountId);
			},
		);
		const lockAllAccounts = spyOn(storage, "lockAllAccounts");
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		const restoring = manager.initializeLocalVaultState();
		await started;
		const locking = manager.lockAll("cross-context");
		await Promise.resolve();
		expect(lockAllAccounts).not.toHaveBeenCalled();

		releaseRestoration();
		await Promise.all([restoring, locking]);

		expect(lockAllAccounts).toHaveBeenCalledTimes(1);
		expect(manager.getUnlockedAccountIds()).toEqual([]);
		expect(await storage.getUnlockedAccounts()).toEqual([]);
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

		const manager = createManager({
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
		const manager = createManager({
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

	it("publishes an account switch before awaiting platform callbacks", async () => {
		const storage = await createStore({ unlockAcc2: true });
		let release!: () => void;
		let entered!: () => void;
		const callback = new Promise<void>((resolve) => {
			release = resolve;
		});
		const callbackEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
			onActiveChanged: () => {
				entered();
				return callback;
			},
		});
		await manager.initialize();
		let observed: string | null = null;
		manager.subscribe(() => {
			observed = manager.getActiveAccount();
		});
		const switching = manager.switchAccount("acc-2");
		await callbackEntered;
		expect(observed as string | null).toBe("acc-2");
		release();
		await switching;
	});

	it("switching to an already-unlocked account does not restore it again", async () => {
		const storage = await createStore({ unlockAcc2: true });
		const tryRestoreSession = spyOn(storage, "tryRestoreSession");
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});

		await manager.initialize();
		await manager.switchAccount("acc-2");

		expect(tryRestoreSession).not.toHaveBeenCalled();
		expect(manager.getUnlockedAccountIds().sort()).toEqual(["acc-1", "acc-2"]);
	});

	it("reaffirming an already-unlocked account is a silent no-op", async () => {
		const storage = await createStore();
		const tryRestoreSession = spyOn(storage, "tryRestoreSession");
		const verifyUnlockPolicy = mock(async () => {});
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy,
		});
		await manager.initialize();
		const revision = manager.getSnapshot();
		const restorations = tryRestoreSession.mock.calls.length;
		const verifications = verifyUnlockPolicy.mock.calls.length;
		let notifications = 0;
		manager.subscribe(() => {
			notifications++;
		});

		expect(await manager.unlockAccount("acc-1", true)).toBe(true);

		expect(tryRestoreSession).toHaveBeenCalledTimes(restorations);
		expect(verifyUnlockPolicy).toHaveBeenCalledTimes(verifications);
		expect(manager.getSnapshot()).toBe(revision);
		expect(notifications).toBe(0);
	});

	it("switching to a locked account restores only the target", async () => {
		const storage = await createStore();
		const tryRestoreSession = spyOn(storage, "tryRestoreSession");
		const clearSession = spyOn(storage, "clearSession");
		const manager = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
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

	it("publishes locked scope before awaiting broadcast callbacks", async () => {
		const storage = await createStore({ unlockAcc2: true });
		let release!: () => void;
		let entered!: () => void;
		const callback = new Promise<void>((resolve) => {
			release = resolve;
		});
		const callbackEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
			onLockBroadcast: () => {
				entered();
				return callback;
			},
		});
		await manager.initialize();
		let observed: string[] | null = null;
		manager.subscribe(() => {
			observed = manager.getUnlockedAccountIds();
		});
		const locking = manager.lockAll();
		await callbackEntered;
		expect(observed as string[] | null).toEqual([]);
		release();
		await locking;
	});

	it("removeAccount switches to remaining account when active is removed", async () => {
		const storage = await createStore();
		const clearAllStoredData = spyOn(storage, "clearAllStoredData");
		const setActiveAccount = spyOn(storage, "setActiveAccount");
		const manager = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
			storage,
			itemCache,
			verifyUnlockPolicy: async () => {},
		});
		await manager.initialize();
		await manager.removeAccount("acc-1");

		const reconstructed = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
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
		const manager = createManager({
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
