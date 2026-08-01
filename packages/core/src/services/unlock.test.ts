import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type { InMemoryPlatformPort } from "@bittery/storage/testing";
import type { ICrypto, KdfProfile } from "@bittery/types";
import {
	accountMetadata,
	createTestAccountStore,
	createTestItemCache,
	mukFor,
} from "../testing/account-store-harness";
import { resetTravelModeEnforcerForTests } from "./travel-mode-enforcer";
import { unlockAccount, unlockAll } from "./unlock";

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
 * Unroutable on purpose: every RPC client built below is real, so the travel
 * mode fetch has to fail fast and fall back to the locally cached policy — the
 * offline path, which is what these tests are about.
 */
const OFFLINE_SERVER_URL = "http://127.0.0.1:1";

/** Enough of `ICrypto` for the local (no re-auth) unlock path. */
function createCrypto(): ICrypto {
	return {
		validateSecretKey: mock(async () => true),
		deriveKeys: mock(async (_password: string, secretKey: string) => ({
			authKey: new TextEncoder().encode(`auth:${secretKey}`),
			masterUnlockKey: mukFor(secretKey),
		})),
	} as unknown as ICrypto;
}

let crypto: ICrypto;
let itemCache: ItemCache;

interface SeedOptions {
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
	const {
		withSecretKey = ["acc-1", "acc-2"],
		withAuthToken = ["acc-1", "acc-2"],
		withKdfProfile = ["acc-1", "acc-2"],
		verifiable = ["acc-1", "acc-2"],
		biometric = false,
	} = options;

	const { store, port } = await createTestAccountStore();
	if (biometric) {
		port.biometricState.hasHardware = true;
		port.biometricState.isEnrolled = true;
		port.biometricState.authenticates = true;
	}

	for (const [accountId, email] of ACCOUNTS) {
		await store.addAccount(accountMetadata({ accountId, email }));
		await store.storeServerUrl(OFFLINE_SERVER_URL, accountId);
		await store.storeSessionData(
			mukFor(accountId),
			accountId,
			email,
			accountId,
		);
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

const password = { kind: "password", password: "pw" } as const;
const biometric = {
	kind: "biometric",
	promptMessage: "Unlock all accounts",
} as const;

describe("unlockAll", () => {
	beforeEach(async () => {
		resetTravelModeEnforcerForTests();
		crypto = createCrypto();
		itemCache = (await createTestItemCache()).cache;
	});

	it("returns the user to the account they were last using", async () => {
		const { storage } = await createStorage();
		await storage.setActiveAccount({ type: "single", accountId: "acc-1" });

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		expect(outcome.failed).toEqual([]);
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-1",
		});
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

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
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
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-2",
		});
	});

	it("reports no_auth_token when the account has a secret key but no token", async () => {
		const { storage } = await createStorage({ withAuthToken: ["acc-2"] });

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
		);

		expect(outcome.failed).toEqual([
			{ accountId: "acc-1", email: "a@test.com", reason: "no_auth_token" },
		]);
	});

	it("reports credential_rejected when the unlock itself fails", async () => {
		const { storage } = await createStorage({ withKdfProfile: ["acc-2"] });

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
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

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
			{ setActive: false },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		// Still reported, just not written.
		expect(outcome.activeAccountId).toBe("acc-1");
		expect(await storage.getActiveAccount()).toBeNull();
	});

	it("filters to the requested emails but still returns ids", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAll(
			{ credential: password, emails: ["b@test.com"] },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.activeAccountId).toBe("acc-2");
	});

	it("does not move the active account when nothing unlocks", async () => {
		const { storage } = await createStorage({ withSecretKey: [] });
		await storage.setActiveAccount({ type: "single", accountId: "acc-1" });

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.activeAccountId).toBeUndefined();
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-1",
		});
	});

	it("unlocks every account restored by one biometric prompt", async () => {
		const { storage, port } = await createStorage({ biometric: true });

		const outcome = await unlockAll(
			{ credential: biometric },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual(["acc-1", "acc-2"]);
		expect(outcome.failed).toEqual([]);
		expect(port.calls.biometricAuthenticate).toBe(1);
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-1",
		});
	});

	it("excludes an account that fails travel mode from active selection", async () => {
		const { storage } = await createStorage({
			biometric: true,
			verifiable: ["acc-2"],
		});
		await storage.setActiveAccount({ type: "single", accountId: "acc-1" });

		const outcome = await unlockAll(
			{ credential: biometric },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "travel_mode_unverified",
			},
		]);
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-2",
		});
	});

	it("reports travel_mode_unverified when a password unlock cannot verify the policy", async () => {
		const { storage } = await createStorage({ verifiable: ["acc-2"] });
		await storage.setActiveAccount({ type: "single", accountId: "acc-1" });

		const outcome = await unlockAll(
			{ credential: password },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(outcome.failed).toEqual([
			{
				accountId: "acc-1",
				email: "a@test.com",
				reason: "travel_mode_unverified",
			},
		]);
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-2",
		});
		// Fail closed: the unverified account must not stay unlocked.
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
	});

	it("clears the session of an account that fails travel mode", async () => {
		const { storage } = await createStorage({
			biometric: true,
			verifiable: ["acc-2"],
		});

		await unlockAll({ credential: biometric }, { storage, itemCache, crypto });

		// Fail closed: the rejected account must not stay unlocked.
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
		expect(await storage.getAuthToken("acc-1")).toBeNull();
	});
});

describe("unlockAccount", () => {
	beforeEach(async () => {
		resetTravelModeEnforcerForTests();
		crypto = createCrypto();
		itemCache = (await createTestItemCache()).cache;
	});

	it("unlocks only the requested account", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAccount(
			{ accountId: "acc-2", credential: password },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual(["acc-2"]);
		expect(await storage.getUnlockedAccounts()).toEqual(["acc-2"]);
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "acc-2",
		});
	});

	it("reports an unknown account instead of throwing", async () => {
		const { storage } = await createStorage();

		const outcome = await unlockAccount(
			{ accountId: "acc-404", credential: password },
			{ storage, itemCache, crypto },
		);

		expect(outcome.unlocked).toEqual([]);
		expect(outcome.failed).toEqual([
			{ accountId: "acc-404", email: "", reason: "no_stored_secret_key" },
		]);
	});
});
