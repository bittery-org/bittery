import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { KdfProfile } from "@bittery/crypto-port";
import {
	createInMemoryCryptoPort,
	type InMemoryCryptoPort,
} from "@bittery/crypto-port/testing";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type { InMemoryPlatformPort } from "@bittery/storage/testing";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	mukRefFor,
} from "../testing/account-store-harness";
import { NO_CREDENTIAL_MIRROR } from "./account-lifecycle";
import { storeUnlockSession } from "./auth-service";
import { resetTravelModeEnforcerForTests } from "./travel-mode-enforcer";
import {
	unlockAccountWithBiometric,
	unlockAccountWithPassword,
	unlockAllWithBiometric,
	unlockAllWithPassword,
} from "./unlock";

const ACCOUNTS = [
	["acc-1", "a@test.com"],
	["acc-2", "b@test.com"],
] as const;

const KDF_PROFILE: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

/**
 * Unroutable on purpose: every API client built below is real, so the travel
 * mode fetch has to fail fast and fall back to the locally cached policy — the
 * offline path, which is what these tests are about.
 */
const OFFLINE_SERVER_URL = "http://127.0.0.1:1";

let cryptoPort: InMemoryCryptoPort;
let crypto: InMemoryCryptoPort;
let itemCache: ItemCache;
const credentialMirror = NO_CREDENTIAL_MIRROR;

interface SeedOptions {
	/** Overrides the seeded `[accountId, email]` pairs; every other list defaults to all of them. */
	accounts?: readonly (readonly [string, string])[];
	/** Accounts whose password unlock can succeed at all. */
	withSecretKey?: string[];
	withAuthToken?: string[];
	/** Accounts with a pinned KDF profile; without one `performSRPUnlock` fails closed. */
	withKdfProfile?: string[];
	/**
	 * Accounts with a cached travel mode policy — the only thing that lets the
	 * enforcer verify while offline, so an account left out fails closed.
	 */
	verifiable?: string[];
	/** Accounts enrolled in biometrics with a restorable session. */
	biometric?: boolean;
}

async function createStorage(
	options: SeedOptions = {},
): Promise<{ storage: AccountStore; port: InMemoryPlatformPort }> {
	const seeded = options.accounts ?? ACCOUNTS;
	const seededIds = seeded.map(([accountId]) => accountId);
	const {
		withSecretKey = seededIds,
		withAuthToken = seededIds,
		withKdfProfile = seededIds,
		verifiable = seededIds,
		biometric = false,
	} = options;

	const { store, port } = await createTestAccountStore({ crypto: cryptoPort });
	if (biometric) {
		port.biometricState.hasHardware = true;
		port.biometricState.isEnrolled = true;
		port.biometricState.authenticates = true;
	}

	for (const [accountId, email] of seeded) {
		await store.addAccount(accountMetadata({ accountId, email }));
		await store.storeServerUrl(OFFLINE_SERVER_URL, accountId);
		const sessionKey = await mukRefFor(cryptoPort, accountId);
		await store.storeSessionData(sessionKey, accountId, email, accountId);
		await cryptoPort.destroyKey(sessionKey);
		if (withAuthToken.includes(accountId)) {
			await store.storeAuthToken(`token-${accountId}`, accountId);
		}
		if (withSecretKey.includes(accountId)) {
			await store.storeSecretKey(`secret-${accountId}`, accountId);
		}
		if (withKdfProfile.includes(accountId)) {
			await store.storePinnedKdfProfile(KDF_PROFILE, accountId);
		}
		if (verifiable.includes(accountId)) {
			await store.storeTravelModeCache(
				{ enabled: false, hiddenVaultIds: [] },
				accountId,
			);
		}
		if (biometric) {
			await store.setBiometricEnabled(accountId, true);
		}
	}

	// `storeSessionData` leaves the MUK in memory; drop it so each test starts locked.
	await store.lockAllAccounts();
	return { storage: store, port };
}

const PROMPT = "Unlock all accounts";

/** Advance the wall clock far enough that a 1ms re-entry period has provably elapsed. */
const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 5));

describe("unlock all accounts", () => {
	beforeEach(async () => {
		resetTravelModeEnforcerForTests();
		cryptoPort = createInMemoryCryptoPort();
		crypto = cryptoPort;
		itemCache = (await createTestItemCache()).cache;
	});

	it("returns the user to the account they were last using", async () => {
		const { storage } = await createStorage();
		await storage.setActiveAccount("acc-1");

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		expect(outcome.failed).toEqual([]);
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(await storage.getActiveAccount()).toEqual("acc-1");
		expect((await storage.getUnlockedAccounts()).sort()).toEqual([
			"acc-1",
			"acc-2",
		]);
	});

	it("reports a reason code per failure without any message text", async () => {
		const { storage } = await createStorage({
			withSecretKey: ["acc-2"],
			withAuthToken: ["acc-2"],
		});

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "no_stored_secret_key",
			},
		]);
		// The previously active account is gone, so an unlocked one takes over.
		expect(await storage.getActiveAccount()).toEqual("acc-2");
	});

	/**
	 * A lock drops `jwt_token` and keeps `session_data`, so "no stored token" is the
	 * ordinary state of a locked account rather than a reason to refuse. This unlock
	 * has to reach the server and re-run SRP; against `OFFLINE_SERVER_URL` that fails,
	 * and the failure being `credential_rejected` is the proof it was attempted at all.
	 */
	it("re-runs SRP for an account whose lock already dropped the auth token", async () => {
		const { storage } = await createStorage({ withAuthToken: ["acc-2"] });

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "credential_rejected",
			},
		]);
	});

	it("reports credential_rejected when the unlock itself fails", async () => {
		const { storage } = await createStorage({ withKdfProfile: ["acc-2"] });

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "credential_rejected",
			},
		]);
	});

	it("leaves the active account untouched when setActive is false", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
			{ setActive: false },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		// Still reported, just not written.
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(await storage.getActiveAccount()).toBeNull();
	});

	it("filters to the requested account ids", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAllWithPassword(
			{ password: "pw", accountIds: ["acc-2"] },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.activeAccountId).toBe("acc-2");
	});

	it("does not move the active account when nothing unlocks", async () => {
		const { storage } = await createStorage({ withSecretKey: [] });
		await storage.setActiveAccount("acc-1");

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.activeAccountId).toBeUndefined();
		expect(await storage.getActiveAccount()).toEqual("acc-1");
	});

	it("unlocks every account restored by one biometric prompt", async () => {
		const { storage, port } = await createStorage({ biometric: true });

		const outcome = await unlockAllWithBiometric(
			{ promptMessage: PROMPT },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		expect(outcome.failed).toEqual([]);
		expect(port.calls.biometricAuthenticate).toBe(1);
		expect(await storage.getActiveAccount()).toEqual("acc-1");
	});

	it("leaves an account outside the requested account ids locked", async () => {
		const { storage } = await createStorage({ biometric: true });

		const outcome = await unlockAllWithBiometric(
			{ promptMessage: PROMPT, accountIds: ["acc-2"] },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		// One prompt restores every enrolled account, but travel mode is only
		// verified for the narrowed ones, so the rest must not stay unlocked.
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
	});

	it("excludes an account that fails travel mode from active selection", async () => {
		const { storage } = await createStorage({
			biometric: true,
			verifiable: ["acc-2"],
		});
		await storage.setActiveAccount("acc-1");

		const outcome = await unlockAllWithBiometric(
			{ promptMessage: PROMPT },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "travel_mode_unverified",
			},
		]);
		expect(await storage.getActiveAccount()).toEqual("acc-2");
	});

	it("reports travel_mode_unverified when a password unlock cannot verify the policy", async () => {
		const { storage } = await createStorage({ verifiable: ["acc-2"] });
		await storage.setActiveAccount("acc-1");

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "travel_mode_unverified",
			},
		]);
		expect(await storage.getActiveAccount()).toEqual("acc-2");
		// Fail closed: the unverified account must not stay unlocked, and the
		// session it already had on disk must be torn down.
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
		expect(await storage.getAuthToken("acc-1")).toBeNull();
	});

	it("verifies travel mode once per account on a password unlock", async () => {
		const { storage } = await createStorage();
		const getTravelModeCache = spyOn(storage, "getTravelModeCache");

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		// Offline, so every verification falls back to the cached policy: one read
		// per account, not one per account per verification pass.
		expect(
			getTravelModeCache.mock.calls.map(([accountId]) => accountId),
		).toEqual(["acc-1", "acc-2"]);
	});

	it("stamps lastActiveAt only on the account it makes active", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.activeAccountId).toBe("acc-1");
		// `lastActiveAt` reports when an account was last *used*, which the switcher
		// sorts on: unlocking the rest of them must not make every account read as now.
		expect(
			(await storage.getAccountMetadata("acc-1"))?.lastActiveAt,
		).toBeGreaterThan(1);
		expect((await storage.getAccountMetadata("acc-2"))?.lastActiveAt).toBe(1);
	});

	it("locks the rest of the collateral accounts when one lock fails", async () => {
		const { storage } = await createStorage({
			accounts: [...ACCOUNTS, ["acc-3", "c@test.com"]],
			biometric: true,
		});
		const clearMasterUnlockKey = storage.clearMasterUnlockKey.bind(storage);
		spyOn(storage, "clearMasterUnlockKey").mockImplementation(
			async (accountId?: string) => {
				if (accountId === "acc-1") {
					throw new Error("keychain unavailable");
				}
				await clearMasterUnlockKey(accountId);
			},
		);

		const outcome = await unlockAllWithBiometric(
			{ promptMessage: PROMPT, accountIds: ["acc-3"] },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-3"]);
		// Only the account whose lock failed may stay unlocked: aborting the loop
		// would leave the rest of the collateral unlocked, travel mode unverified.
		expect((await storage.getUnlockedAccounts()).sort()).toEqual([
			"acc-1",
			"acc-3",
		]);
	});

	it("reports travel_mode_unverified even when clearing the session fails", async () => {
		const { storage } = await createStorage({ verifiable: ["acc-2"] });
		const clearSession = storage.clearSession.bind(storage);
		spyOn(storage, "clearSession").mockImplementation(
			async (accountId?: string) => {
				if (accountId === "acc-1") {
					throw new Error("keychain unavailable");
				}
				await clearSession(accountId);
			},
		);

		const outcome = await unlockAllWithPassword(
			{ password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		// A cleanup that throws must neither escape the batch nor cost the
		// remaining accounts their unlock.
		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "travel_mode_unverified",
			},
		]);
	});

	it("clears the session of an account that fails travel mode", async () => {
		const { storage } = await createStorage({
			biometric: true,
			verifiable: ["acc-2"],
		});
		const purge = mock(async () => {});
		const forgetQuickUnlock = mock(async () => {});

		await unlockAllWithBiometric(
			{ promptMessage: PROMPT },
			{
				storage,
				itemCache,
				credentialMirror: { purge, forgetQuickUnlock },
			},
		);

		// Fail closed: the rejected account must not stay unlocked.
		expect(purge).toHaveBeenCalledWith([
			expect.objectContaining({ accountId: "acc-1" }),
		]);
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
		expect(await storage.getAuthToken("acc-1")).toBeNull();
	});
});

describe("unlock one account", () => {
	beforeEach(async () => {
		resetTravelModeEnforcerForTests();
		cryptoPort = createInMemoryCryptoPort();
		crypto = cryptoPort;
		itemCache = (await createTestItemCache()).cache;
	});

	it("unlocks only the requested account", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAccountWithPassword(
			{ accountId: "acc-2", password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
		expect(await storage.getActiveAccount()).toEqual("acc-2");
	});

	it("keeps the stored fields an unlock never sees", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAccountWithPassword(
			{ accountId: "acc-2", password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
			{ setActive: false },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		const metadata = await storage.getAccountMetadata("acc-2");
		// The seeded session data carries `acc-2` as the user id where the account record
		// carries `user-acc-2`: `addAccount` de-dupes on it, so the record has to win.
		expect(metadata?.userId).toBe("user-acc-2");
		expect(metadata?.secretKeyHint).toBe("ABCD••••");
		expect(metadata?.addedAt).toBe(1);
		// Opted out of the active write, so nothing left may stamp `lastActiveAt`.
		expect(metadata?.lastActiveAt).toBe(1);
	});

	it("leaves the other accounts locked after a biometric unlock", async () => {
		const { storage } = await createStorage({ biometric: true });

		const outcome = await unlockAccountWithBiometric(
			{ accountId: "acc-2", promptMessage: PROMPT },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		// One prompt restores every enrolled account, but travel mode is only
		// verified for the requested one, so the rest must not stay unlocked.
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
	});

	it("keeps the biometric error type instead of flattening it to a reason code", async () => {
		const { storage, port } = await createStorage({ biometric: true });
		port.biometricState.isEnrolled = false;

		const outcome = await unlockAccountWithBiometric(
			{ accountId: "acc-2", promptMessage: PROMPT },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.failed[0]?.reason).toBe("credential_rejected");
		expect(outcome.failed[0]?.biometric?.error).toBe("not_enrolled");
	});

	it("reports a travel mode stop on the biometric path with no OS verdict", async () => {
		const { storage } = await createStorage({
			biometric: true,
			verifiable: ["acc-2"],
		});

		const outcome = await unlockAccountWithBiometric(
			{ accountId: "acc-1", promptMessage: PROMPT },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "travel_mode_unverified",
			},
		]);
		// The absence of a `biometric` detail is what forces the hook to map this
		// stop from the reason alone rather than from an OS error type.
		expect(outcome.failed[0]?.biometric).toBeUndefined();
	});

	it("carries the re-entry period out with a master_password_required failure", async () => {
		const { storage } = await createStorage({ biometric: true });
		await storage.storeMasterPasswordReentryPeriodMs(1);
		await tick();

		const outcome = await unlockAccountWithBiometric(
			{ accountId: "acc-2", promptMessage: PROMPT },
			{ storage, itemCache, credentialMirror },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.failed[0]?.biometric?.error).toBe(
			"master_password_required",
		);
		// The UI formats "every N days"; storage only ever publishes the number.
		expect(outcome.failed[0]?.biometric?.masterPasswordReentryPeriodMs).toBe(1);
	});

	it("reports an unknown account instead of throwing", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAccountWithPassword(
			{ accountId: "acc-404", password: "pw" },
			{ storage, itemCache, crypto, credentialMirror },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.failed).toEqual([
			{ accountId: "acc-404", email: "", reason: "no_stored_secret_key" },
		]);
	});
});

/**
 * Driven straight through `storeUnlockSession`: an offline unlock reads `result.user`
 * back out of the record being written, so going via `unlockAccountWithPassword` asserts nothing.
 */
describe("stored account refresh", () => {
	beforeEach(async () => {
		resetTravelModeEnforcerForTests();
		cryptoPort = createInMemoryCryptoPort();
		itemCache = (await createTestItemCache()).cache;
	});

	it("takes the renamed team from the unlock result", async () => {
		const { storage } = await createStorage();
		await storage.addAccount(
			accountMetadata({
				accountId: "acc-2",
				email: "b@test.com",
				name: "Ada",
				teamName: "Old team",
				teamAvatarUrl: "https://avatars.test/old.png",
			}),
		);

		await storeUnlockSession(
			{
				mode: "local",
				token: "token-acc-2",
				user: {
					id: "acc-2",
					email: "b@test.com",
					name: "Ada Lovelace",
					teamName: "New team",
					teamAvatarUrl: "https://avatars.test/new.png",
				},
				vaultKeys: [],
				masterUnlockKey: await mukRefFor(cryptoPort, "acc-2"),
			},
			storage,
			itemCache,
			"acc-2",
			{ setActive: false },
		);

		const metadata = await storage.getAccountMetadata("acc-2");
		expect(metadata?.name).toBe("Ada Lovelace");
		expect(metadata?.teamName).toBe("New team");
		expect(metadata?.teamAvatarUrl).toBe("https://avatars.test/new.png");
		// Refreshed in place: the record's own fields survive the wholesale replace.
		expect(metadata?.userId).toBe("user-acc-2");
		expect(metadata?.secretKeyHint).toBe("ABCD••••");
		expect(metadata?.lastActiveAt).toBe(1);
	});
});
