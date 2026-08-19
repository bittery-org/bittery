/// <reference types="bun" />
/**
 * The `/vault` guard, including the native-borrow path.
 *
 * The bug this pins: the user unlocks inside Bittery's own autofill or
 * credential-provider activity, the Kotlin side puts the master unlock key in the
 * process-local live store, and the app — which never reads that store — shows its
 * lock screen anyway. See
 * `src-tauri/plugins/credential-provider/android/PROCESS-MODEL.md`.
 *
 * A **real** `AccountSessionManager` over a **real** `AccountStore` on the in-memory
 * platform port, so session validity, account identity, the MUK comparison and the
 * unlock-state event are the production ones. Only the credential-provider bridge is a
 * double — there is no Android in a bun test.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import {
	createInMemoryPlatformPort,
	createInMemoryRecordPort,
} from "@bittery/storage/testing";
import type { AccountMetadata } from "@bittery/storage/types";
import {
	resolveResumeAccess,
	resolveVaultRouteAccess,
} from "./vault-route-access";

type Crypto = ReturnType<typeof createInMemoryCryptoPort>;

const ACCOUNT = "acc-1";
const OTHER = "acc-2";

/** A distinct 32-byte master unlock key per account id. */
function mukFor(accountId: string): Uint8Array {
	const bytes = new Uint8Array(32);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (accountId.charCodeAt(i % accountId.length) + i) % 256;
	}
	return bytes;
}

function mukBase64For(accountId: string): string {
	return arrayBufferToBase64(mukFor(accountId));
}

function accountMetadata(accountId: string): AccountMetadata {
	return {
		accountId,
		email: `${accountId}@test.com`,
		userId: `user-${accountId}`,
		name: accountId,
		serverUrl: "https://app.bittery.io",
		secretKeyHint: "ABCD••••",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
		insecureTransportConfirmed: false,
	};
}

async function seedAccount(
	store: AccountStore,
	crypto: Crypto,
	accountId: string,
	{ unlocked = false }: { unlocked?: boolean } = {},
): Promise<void> {
	const metadata = accountMetadata(accountId);
	await store.addAccount(metadata);
	await store.storeSecretKey(`secret-${accountId}`, accountId);
	await store.storeAuthToken(`token-${accountId}`, accountId);

	const sessionKey = await crypto.importKey(mukFor(accountId));
	await store.storeSessionData(
		sessionKey,
		accountId,
		metadata.email,
		metadata.userId,
	);
	await crypto.destroyKey(sessionKey);

	if (unlocked) {
		await store.setMasterUnlockKey(
			await crypto.importKey(mukFor(accountId)),
			accountId,
		);
	}
}

interface Harness {
	store: AccountStore;
	crypto: Crypto;
	itemCache: ItemCache;
}

async function createHarness(): Promise<Harness> {
	const crypto = createInMemoryCryptoPort();
	const store = createAccountStore({
		port: createInMemoryPlatformPort({ sessionSurvivesRestart: true }),
		crypto,
	});
	await store.initialize();
	const itemCache = createItemCache({ port: createInMemoryRecordPort() });
	await itemCache.initialize();
	return { store, crypto, itemCache };
}

function createManager(
	harness: Harness,
	verifyUnlockPolicy?: (accountId: string) => Promise<void>,
): AccountSessionManager {
	return new AccountSessionManager({
		storage: harness.store,
		itemCache: harness.itemCache,
		crypto: harness.crypto,
		verifyUnlockPolicy: verifyUnlockPolicy ?? (async () => {}),
	});
}

/**
 * The native bridge, and the proof that borrowing is silent: `authenticate` is the only
 * command that can raise a biometric sheet, and a borrow must never reach it.
 */
function createProvider(liveKeys: Record<string, string>) {
	const borrowed: string[] = [];
	const authenticate = mock(async () => true);
	return {
		borrowed,
		authenticate,
		bridge: {
			borrowLiveMasterUnlockKey: async (accountId: string) => {
				borrowed.push(accountId);
				return liveKeys[accountId] ?? null;
			},
		},
	};
}

let harness: Harness;

describe("resolveVaultRouteAccess", () => {
	beforeEach(async () => {
		harness = await createHarness();
	});

	test("sends a device with no active account to login", async () => {
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("login");
		expect(provider.borrowed).toEqual([]);
	});

	test("lets an account already unlocked in JavaScript straight through", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT, {
			unlocked: true,
		});
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("ready");
		// Nothing to borrow: the key is already here.
		expect(provider.borrowed).toEqual([]);
	});

	test("hydrates from a live native master unlock key when the JS restore refuses", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		// The explicit restore is what fails on a device after a native-only unlock.
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const access = await resolveVaultRouteAccess(
			manager,
			harness.store,
			provider.bridge,
		);

		expect(access).toBe("ready");
		expect(provider.borrowed).toEqual([ACCOUNT]);
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);
		expect(await harness.store.getUnlockedAccounts()).toEqual([ACCOUNT]);
		// Borrowing is silent. A biometric sheet here would be a new prompt on boot.
		expect(provider.authenticate).not.toHaveBeenCalled();
	});

	test("falls back to the explicit restore when the native side is locked", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("ready");
		expect(provider.borrowed).toEqual([ACCOUNT]);
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);
	});

	test("keeps today's behaviour when the plugin is unavailable", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		harness.store.tryRestoreSession = async () => false;

		// What `credential-provider.ts` answers on a host with no plugin: a stated null.
		const unavailable = { borrowLiveMasterUnlockKey: async () => null };
		expect(
			await resolveVaultRouteAccess(manager, harness.store, unavailable),
		).toBe("unlock");
	});

	test("ignores a live key that belongs to another account", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await seedAccount(harness.store, harness.crypto, OTHER);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({ [ACCOUNT]: mukBase64For(OTHER) });
		const access = await resolveVaultRouteAccess(
			manager,
			harness.store,
			provider.bridge,
		);

		expect(access).toBe("unlock");
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
		expect(await harness.store.getUnlockedAccounts()).toEqual([]);
	});

	test("rejects a live key that is not this account's key", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({
			[ACCOUNT]: arrayBufferToBase64(new Uint8Array(32).fill(7)),
		});
		const access = await resolveVaultRouteAccess(
			manager,
			harness.store,
			provider.bridge,
		);

		expect(access).toBe("unlock");
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
		expect(await harness.store.getUnlockedAccounts()).toEqual([]);
	});

	test("does not borrow at all once the session is invalid", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		// A missing auth token is what `isSessionValid` refuses on.
		await harness.store.clearSession(ACCOUNT);

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const access = await resolveVaultRouteAccess(
			manager,
			harness.store,
			provider.bridge,
		);

		expect(access).toBe("unlock");
		expect(provider.borrowed).toEqual([]);
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
	});

	test("refuses a live key when travel-mode verification fails", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness, async () => {
			throw new Error("travel mode not verified");
		});
		await manager.refresh();
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const access = await resolveVaultRouteAccess(
			manager,
			harness.store,
			provider.bridge,
		);

		expect(access).toBe("unlock");
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
		expect(await harness.store.getUnlockedAccounts()).toEqual([]);
	});
});

/**
 * The cold-start path: the launcher icon after an unlock that happened inside Bittery's
 * own autofill activity.
 *
 * `/` used to answer this with its own copy of the guard — accounts list, adopt the
 * first one, `isSessionValid`, `unlockAccount(id, true)` — which never borrowed, so the
 * one screen the bug is actually about kept showing the lock. These pin the two halves
 * the copy owned and this function now owns: adopting a stored account when the device
 * points at none, and the native borrow on top of it.
 */
describe("resolveVaultRouteAccess on a cold start", () => {
	beforeEach(async () => {
		harness = await createHarness();
	});

	test("adopts the only stored account when the device points at none", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		// No `setActiveAccount`: exactly what `/` handled by switching to the first account.
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("ready");
		expect(manager.getActiveAccount()).toBe(ACCOUNT);
		expect(await harness.store.getActiveAccount()).toBe(ACCOUNT);
	});

	test("opens the vault from a live native key with no active account yet", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		// What a device does after a native-only unlock: the explicit restore refuses.
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const access = await resolveVaultRouteAccess(
			manager,
			harness.store,
			provider.bridge,
		);

		expect(access).toBe("ready");
		expect(provider.borrowed).toEqual([ACCOUNT]);
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);
		expect(provider.authenticate).not.toHaveBeenCalled();
	});

	test("keeps the old answer with no live native key: the stored session still opens it", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("ready");
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);
	});

	test("sends a device with no stored account at all to login", async () => {
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("login");
		expect(provider.borrowed).toEqual([]);
	});

	/**
	 * `/` redirects on this answer and `/unlock` does not guard at all, so a loop needs
	 * the decision itself to change its mind between two runs. It must not.
	 */
	test("answers unlock twice, so / and /unlock cannot bounce", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({});
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("unlock");
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("unlock");
	});

	/** The other direction: `/` sends a borrowed unlock to `/vault`, which asks again. */
	test("answers ready twice once the live key is adopted, so / and /vault cannot bounce", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		harness.store.tryRestoreSession = async () => false;

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("ready");
		expect(
			await resolveVaultRouteAccess(manager, harness.store, provider.bridge),
		).toBe("ready");
		// The second run reads the manager's own lock state and asks the bridge nothing.
		expect(provider.borrowed).toEqual([ACCOUNT]);
	});
});

/**
 * Coming back to the foreground.
 *
 * The app can be parked on `/unlock` while the user unlocks in the autofill sheet, and
 * nothing tells it. Re-running the full `/` guard here would be wrong in the opposite
 * direction: that guard restores the stored session without a prompt, so on the screen
 * an auto-lock just navigated to it would undo the lock. Resume therefore lets the
 * auto-lock decide first and then adopts *only* a live native key.
 */
describe("resolveResumeAccess", () => {
	beforeEach(async () => {
		harness = await createHarness();
	});

	const staysUnlocked = {
		shouldLock: async () => false,
		lock: async () => {
			throw new Error("lock must not run when shouldLock said no");
		},
	};

	test("adopts a live native key, so the lock screen can be left", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const outcome = await resolveResumeAccess(
			staysUnlocked,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("unlocked");
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);
		expect(provider.authenticate).not.toHaveBeenCalled();
	});

	test("never restores the stored session, so a resume alone opens nothing", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		// The stored session is intact and `unlockAccount(id, true)` would open it.
		expect(await harness.store.isSessionValid(ACCOUNT)).toBe(true);

		const provider = createProvider({});
		const outcome = await resolveResumeAccess(
			staysUnlocked,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("unchanged");
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
	});

	test("does not silently unlock after an auto-lock", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT, {
			unlocked: true,
		});
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);

		// The native key is deliberately left live: the real purge is asynchronous, so a
		// resume that borrowed before checking the auto-lock would walk straight back in.
		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const autolock = {
			shouldLock: async () => true,
			lock: async () => {
				await harness.store.clearMasterUnlockKey(ACCOUNT);
				await manager.lockAll();
			},
		};

		const outcome = await resolveResumeAccess(
			autolock,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("locked");
		expect(provider.borrowed).toEqual([]);
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
		expect(await harness.store.getUnlockedAccounts()).toEqual([]);
	});

	test("asks the bridge nothing while the vault is already open", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT, {
			unlocked: true,
		});
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const outcome = await resolveResumeAccess(
			staysUnlocked,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("unchanged");
		expect(provider.borrowed).toEqual([]);
		expect(manager.isUnlocked(ACCOUNT)).toBe(true);
	});

	test("refuses a live key that is not this account's key", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();

		const provider = createProvider({
			[ACCOUNT]: arrayBufferToBase64(new Uint8Array(32).fill(7)),
		});
		const outcome = await resolveResumeAccess(
			staysUnlocked,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("unchanged");
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
	});

	test("refuses a live key once the session is invalid", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness);
		await manager.refresh();
		await harness.store.clearSession(ACCOUNT);

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const outcome = await resolveResumeAccess(
			staysUnlocked,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("unchanged");
		expect(provider.borrowed).toEqual([]);
	});

	test("refuses a live key when travel-mode verification fails", async () => {
		await seedAccount(harness.store, harness.crypto, ACCOUNT);
		await harness.store.setActiveAccount(ACCOUNT);
		const manager = createManager(harness, async () => {
			throw new Error("travel mode not verified");
		});
		await manager.refresh();

		const provider = createProvider({ [ACCOUNT]: mukBase64For(ACCOUNT) });
		const outcome = await resolveResumeAccess(
			staysUnlocked,
			manager,
			harness.store,
			provider.bridge,
		);

		expect(outcome).toBe("unchanged");
		expect(manager.isUnlocked(ACCOUNT)).toBe(false);
		expect(await harness.store.getUnlockedAccounts()).toEqual([]);
	});
});
