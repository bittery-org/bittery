import { describe, expect, it, mock, spyOn } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import {
	createInMemoryCryptoPort,
	type InMemoryCryptoPort,
} from "@bittery/crypto-port/testing";
import type { AccountStore } from "@bittery/storage";
import type { InMemoryPlatformPort } from "@bittery/storage/testing";
import type { AccountMetadata } from "@bittery/storage/types";
import type { KdfProfile } from "@bittery/types";
import {
	createTestAccountStore,
	createTestItemCache,
} from "../testing/account-store-harness";
import {
	deriveSrpLoginProof,
	getBiometricUnlockAvailability,
	type IAuthClient,
	type LoginResult,
	performSRPLogin,
	performSRPUnlock,
	storeLoginSession,
	storeLoginSessionOwned,
	storeUnlockSession,
	type UnlockResult,
} from "./auth-service";
import { resetTravelModeEnforcerForTests } from "./travel-mode-enforcer";
import type { TravelModeRpcClient } from "./travel-mode-service";

const kdfParams: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

const MUK = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const SECRET_KEY = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
const SERVER_PROOF = "server-proof";

/**
 * One port for every store these tests build, because a `KeyRef` only means anything to the
 * port that minted it.
 */
const cryptoPort = createInMemoryCryptoPort();

async function mukRef(): Promise<KeyRef> {
	return cryptoPort.importKey(MUK);
}

/**
 * A real port that records what reached the account KDF. There is nothing left to stub:
 * `CryptoPort` is total, so the fake answers every call the flow makes, and the only thing
 * a test has to observe is which secret key, email and profile the derivation ran with.
 */
interface RecordedDerivation {
	secretKey: string;
	email: string;
	profile: KdfProfile;
}

function createRecordingCryptoPort(): {
	crypto: InMemoryCryptoPort;
	derivations: RecordedDerivation[];
} {
	const crypto = createInMemoryCryptoPort();
	const derivations: RecordedDerivation[] = [];
	const deriveMasterKey = crypto.deriveMasterKey.bind(crypto);
	crypto.deriveMasterKey = async (password, secretKey, email, profile) => {
		derivations.push({ secretKey, email, profile });
		return deriveMasterKey(password, secretKey, email, profile);
	};
	// The fake auth client never sees the client session key, so it cannot compute a real
	// server proof. This stands in for the server half of the handshake — still a literal
	// comparison, so a flow that forgets to verify at all is not what makes these pass.
	crypto.verifyServerSession = async (_publicEphemeral, _session, proof) => {
		if (proof !== SERVER_PROOF) {
			throw new Error("Server session proof did not verify.");
		}
	};
	return { crypto, derivations };
}

function account(
	accountId: string,
	userId: string,
	serverUrl: string,
): AccountMetadata {
	return {
		accountId,
		email: "same@example.com",
		userId,
		name: accountId,
		serverUrl,
		secretKeyHint: "ABCD••••",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
	};
}

/**
 * A real `AccountStore` over the in-memory platform port. The real store answers every
 * one of these queries from what the test actually wrote.
 */
async function makeStore(
	accounts: AccountMetadata[] = [],
	crypto: InMemoryCryptoPort = cryptoPort,
): Promise<{ storage: AccountStore; port: InMemoryPlatformPort }> {
	const { store, port } = await createTestAccountStore({ crypto });
	for (const metadata of accounts) {
		await store.addAccount(metadata);
	}
	return { storage: store, port };
}

function createAuthClient(
	startedEmails: string[],
	token = "token",
): IAuthClient {
	return {
		auth: {
			checkEmail: { query: mock(async () => ({ exists: true })) },
			startLogin: {
				mutate: mock(async ({ email }) => {
					startedEmails.push(email);
					return {
						attemptId: "attempt",
						salt: "srp-salt",
						serverPublicKey: "server-public",
						kdfParams,
					};
				}),
			},
			finishLogin: {
				mutate: mock(async () => ({
					token,
					serverProof: "server-proof",
					user: { id: "user-new", email: "same@example.com" },
					expiresAt: new Date(Date.now() + 60_000),
				})),
			},
			logout: { mutate: mock(async () => ({ success: true })) },
			refreshSession: {
				mutate: mock(async () => ({
					token,
					sessionId: "session",
					expiresAt: new Date(Date.now() + 60_000),
				})),
			},
		},
		vault: { list: { query: mock(async () => []) } },
	};
}

describe("account-routed authentication", () => {
	it("reports biometric unlock when any account is eligible", async () => {
		const accounts = [
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://b.example"),
		];
		const { storage, port } = await makeStore(accounts);
		port.biometricState.hasHardware = true;
		port.biometricState.isEnrolled = true;

		// Both accounts have a live session; only account-b has biometric turned on.
		for (const metadata of accounts) {
			await storage.storeAuthToken(
				`token-${metadata.accountId}`,
				metadata.accountId,
			);
			await storage.storeSessionData(
				await cryptoPort.importKey(MUK),
				metadata.accountId,
				metadata.email,
				metadata.userId,
			);
		}
		await storage.setBiometricEnabled("account-b", true);

		const canBiometricUnlock = spyOn(storage, "canBiometricUnlock");

		const availability = await getBiometricUnlockAvailability(storage, [
			"account-a",
			"account-b",
		]);

		expect(availability).toEqual({
			canUnlock: true,
			requiresPasswordReentry: false,
		});
		expect(canBiometricUnlock.mock.calls).toEqual([
			["account-a"],
			["account-b"],
		]);
	});

	it("derives proofs for duplicate-email accounts from only the requested account", async () => {
		const accounts = [
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://b.example"),
		];
		const { storage } = await makeStore(accounts);
		for (const metadata of accounts) {
			await storage.storeSecretKey(
				`secret-${metadata.accountId}`,
				metadata.accountId,
			);
			await storage.storePinnedKdfProfile(kdfParams, metadata.accountId);
		}

		const clientAccountIds: string[] = [];
		const startedEmails: string[] = [];
		const getPinnedKdfProfile = spyOn(storage, "getPinnedKdfProfile");
		const { crypto, derivations } = createRecordingCryptoPort();

		for (const accountId of ["account-a", "account-b"]) {
			await deriveSrpLoginProof(
				{ accountId, password: "password" },
				{
					crypto,
					storage,
					createAuthClientForAccount: async (resolvedAccountId) => {
						clientAccountIds.push(resolvedAccountId);
						return createAuthClient(startedEmails);
					},
				},
			);
		}

		expect(
			derivations.map((entry) => `${entry.secretKey}:${entry.email}`),
		).toEqual([
			"secret-account-a:same@example.com",
			"secret-account-b:same@example.com",
		]);
		expect(getPinnedKdfProfile.mock.calls).toEqual([
			["account-a"],
			["account-a"],
			["account-b"],
			["account-b"],
		]);
		expect(clientAccountIds).toEqual(["account-a", "account-b"]);
		expect(startedEmails).toEqual(["same@example.com", "same@example.com"]);
	});

	it("does not mutate storage or the active account before login commit", async () => {
		const { crypto } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[account("cloud", "cloud-user", "https://cloud.example")],
			crypto,
		);
		await storage.setActiveAccount("cloud");

		const writes = {
			storeAuthToken: spyOn(storage, "storeAuthToken"),
			storeServerUrl: spyOn(storage, "storeServerUrl"),
			storePinnedKdfProfile: spyOn(storage, "storePinnedKdfProfile"),
			setActiveAccount: spyOn(storage, "setActiveAccount"),
		};
		const startedEmails: string[] = [];
		const handshakeClient = createAuthClient(startedEmails, "self-token");
		const authenticatedClient = createAuthClient([], "self-token");

		const result = await performSRPLogin(
			{
				email: "same@example.com",
				password: "password",
				secretKey: SECRET_KEY,
				serverUrl: "https://self-hosted.example/",
			},
			{
				crypto,
				authClient: handshakeClient,
				storage,
				createAuthenticatedClient: (token, serverUrl) => {
					expect(token).toBe("self-token");
					expect(serverUrl).toBe("https://self-hosted.example");
					return authenticatedClient;
				},
			},
		);

		expect(result.serverUrl).toBe("https://self-hosted.example");
		expect(await storage.getActiveAccount()).toEqual("cloud");
		for (const write of Object.values(writes)) {
			expect(write).not.toHaveBeenCalled();
		}
	});

	it("validates full login against the pin selected by normalized server and email", async () => {
		const { crypto, derivations } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[
				account("account-a", "user-a", "https://a.example"),
				account("account-b", "user-b", "https://b.example"),
			],
			crypto,
		);
		// account-a's pin would reject the server's profile as a downgrade; account-b's
		// accepts it. Which one is consulted is therefore observable from the outcome.
		await storage.storePinnedKdfProfile(
			{ ...kdfParams, iterations: 700_000 },
			"account-a",
		);
		await storage.storePinnedKdfProfile({ ...kdfParams }, "account-b");
		const getPinnedKdfProfile = spyOn(storage, "getPinnedKdfProfile");

		await performSRPLogin(
			{
				email: " SAME@example.com ",
				password: "password",
				secretKey: SECRET_KEY,
				serverUrl: "https://B.example/",
			},
			{
				crypto,
				storage,
				authClient: createAuthClient([]),
				createAuthenticatedClient: () => createAuthClient([]),
			},
		);

		expect(getPinnedKdfProfile).toHaveBeenCalledWith("account-b");
		expect(derivations).toHaveLength(1);
		expect(derivations[0]?.profile.iterations).toBe(600_000);
	});

	it("rejects a full-login downgrade before deriving keys", async () => {
		const { crypto, derivations } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[account("account-a", "user-a", "https://a.example")],
			crypto,
		);
		await storage.storePinnedKdfProfile(
			{ ...kdfParams, iterations: 1_200_000 },
			"account-a",
		);

		expect(
			performSRPLogin(
				{
					email: "same@example.com",
					password: "password",
					secretKey: SECRET_KEY,
					serverUrl: "https://a.example",
				},
				{ crypto, storage, authClient: createAuthClient([]) },
			),
		).rejects.toThrow("downgraded");
		expect(derivations).toHaveLength(0);
	});

	it("rejects ambiguous full-login account matches before derivation", async () => {
		const { crypto, derivations } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[
				account("account-a", "user-a", "https://a.example"),
				account("account-b", "user-b", "https://a.example/"),
			],
			crypto,
		);

		expect(
			performSRPLogin(
				{
					email: "same@example.com",
					password: "password",
					secretKey: SECRET_KEY,
					serverUrl: "https://a.example",
				},
				{ crypto, storage, authClient: createAuthClient([]) },
			),
		).rejects.toThrow("Ambiguous account");
		expect(derivations).toHaveLength(0);
	});
});

describe("KDF agility on unlock", () => {
	const pinnedProfile: KdfProfile = {
		schemaVersion: 1,
		algorithm: "pbkdf2-sha256",
		iterations: 600_000,
	};

	it("derives unlock keys with the account's pinned KDF profile", async () => {
		const { crypto, derivations } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[account("acct", "user", "https://acct.example")],
			crypto,
		);
		await storage.storeSecretKey("secret", "acct");
		await storage.storePinnedKdfProfile(pinnedProfile, "acct");
		await storage.storeAuthToken("token", "acct");
		await storage.storeVaultKeys([], "acct");
		await storage.storeSessionData(
			await crypto.importKey(MUK),
			"acct",
			"same@example.com",
			"user",
		);

		const result = await performSRPUnlock(
			{ accountId: "acct", password: "password" },
			{
				crypto,
				storage,
				createAuthClientForAccount: async () => createAuthClient([]),
			},
		);

		expect(result.mode).toBe("local");
		expect(derivations).toHaveLength(1);
		expect(derivations[0]?.profile.iterations).toBe(600_000);
	});

	it("requires full sign-in when the offline-unlock pin is missing", async () => {
		const { crypto, derivations } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[account("acct", "user", "https://acct.example")],
			crypto,
		);
		await storage.storeSecretKey("secret", "acct");

		expect(
			performSRPUnlock(
				{ accountId: "acct", password: "password" },
				{
					crypto,
					storage,
					createAuthClientForAccount: async () => createAuthClient([]),
				},
			),
		).rejects.toThrow("sign in again");
		expect(derivations).toHaveLength(0);
	});

	it("derives SRP login proofs with the negotiated server KDF params, not the current default", async () => {
		const { crypto, derivations } = createRecordingCryptoPort();
		const { storage } = await makeStore(
			[account("acct", "user", "https://acct.example")],
			crypto,
		);
		await storage.storeSecretKey("secret", "acct");
		await storage.storePinnedKdfProfile(pinnedProfile, "acct");

		const authClient = {
			auth: {
				startLogin: {
					mutate: mock(async () => ({
						attemptId: "attempt",
						salt: "srp-salt",
						serverPublicKey: "server-public",
						kdfParams: { ...pinnedProfile },
					})),
				},
			},
			vault: { list: { query: mock(async () => []) } },
		} as unknown as IAuthClient;

		await deriveSrpLoginProof(
			{ accountId: "acct", password: "password" },
			{
				crypto,
				storage,
				createAuthClientForAccount: async () => authClient,
			},
		);

		expect(derivations).toHaveLength(1);
		expect(derivations[0]?.profile.iterations).toBe(600_000);
	});
});

describe("storeLoginSession travel mode verification", () => {
	async function loginResult(
		crypto: InMemoryCryptoPort = cryptoPort,
	): Promise<LoginResult> {
		return {
			token: "fresh-login-token",
			sessionId: "session",
			expiresAt: new Date(Date.now() + 60_000),
			user: { id: "user-1", email: "user@example.com" },
			vaultKeys: [],
			masterUnlockKey: await crypto.importKey(MUK),
			kdfParams,
			serverUrl: "https://cloud.example",
		};
	}

	function travelModeClientForToken(
		token: string | null,
		seenTokens: (string | null)[],
	): TravelModeRpcClient {
		return {
			travelMode: {
				getTravelMode: {
					query: mock(async () => {
						seenTokens.push(token);
						if (!token) {
							throw new Error("UNAUTHORIZED");
						}
						return {
							enabled: false,
							hiddenVaultIds: [],
							enabledAt: null,
							updatedAt: new Date().toISOString(),
						};
					}),
				},
			},
		} as unknown as TravelModeRpcClient;
	}

	it("verifies travel mode with the freshly issued login token", async () => {
		resetTravelModeEnforcerForTests();
		// A first login into an empty store: nothing is authenticated yet, so any
		// ambient RPC client reading storage would be unauthenticated.
		const { storage } = await makeStore();
		const storePinnedKdfProfile = spyOn(storage, "storePinnedKdfProfile");
		const seenTokens: (string | null)[] = [];

		await storeLoginSession(
			await loginResult(),
			"secret",
			storage,
			(await createTestItemCache()).cache,
			"user@example.com",
			{
				serverUrl: "https://cloud.example",
				createTravelModeRpcClient: (token: string | null) =>
					travelModeClientForToken(token, seenTokens),
			},
		);

		expect(seenTokens).toEqual(["fresh-login-token"]);
		expect(storePinnedKdfProfile).toHaveBeenCalledWith(
			kdfParams,
			expect.any(String),
		);
	});

	// A reused accountId is the normal case, not an edge case:
	// `resolveOrCreateAccountId` keys on (serverUrl, userId), so signing back in
	// after a sign-out lands on the same id — and therefore the same item-cache
	// collections. Anything left there is the *previous* session's ciphertext.
	it("clears the item cache before writing a session onto a reused accountId", async () => {
		resetTravelModeEnforcerForTests();
		const { storage } = await makeStore();
		const { cache: itemCache } = await createTestItemCache();
		const seenTokens: (string | null)[] = [];

		const accountId = await storeLoginSession(
			await loginResult(),
			"secret",
			storage,
			itemCache,
			"user@example.com",
			{
				serverUrl: "https://cloud.example",
				createTravelModeRpcClient: (token: string | null) =>
					travelModeClientForToken(token, seenTokens),
			},
		);

		await itemCache.setCachedItems(
			[{ id: "stale-item", vaultId: "vault-1" } as never],
			accountId,
		);

		resetTravelModeEnforcerForTests();
		await storeLoginSession(
			await loginResult(),
			"secret",
			storage,
			itemCache,
			"user@example.com",
			{
				serverUrl: "https://cloud.example",
				createTravelModeRpcClient: (token: string | null) =>
					travelModeClientForToken(token, seenTokens),
			},
		);

		expect(await itemCache.getCachedItems(accountId)).toBeNull();
	});

	it("destroys the caller-owned MUK exactly once when session storage fails before transfer", async () => {
		resetTravelModeEnforcerForTests();
		const crypto = createInMemoryCryptoPort();
		const { storage } = await makeStore([], crypto);
		const { cache: itemCache } = await createTestItemCache();
		const destroyKey = spyOn(crypto, "destroyKey");
		spyOn(storage, "storeAuthToken").mockImplementation(async () => {
			throw new Error("auth token write failed");
		});

		await expect(
			storeLoginSessionOwned(
				await loginResult(crypto),
				"secret",
				storage,
				itemCache,
				crypto,
				"user@example.com",
				{
					serverUrl: "https://cloud.example",
					createTravelModeRpcClient: (token: string | null) =>
						travelModeClientForToken(token, []),
				},
			),
		).rejects.toThrow("auth token write failed");

		expect(destroyKey).toHaveBeenCalledTimes(1);
		expect(crypto.liveKeyCount).toBe(0);
	});

	it("leaves a live store-owned MUK cached when metadata fails after transfer", async () => {
		resetTravelModeEnforcerForTests();
		const crypto = createInMemoryCryptoPort();
		const { storage } = await makeStore([], crypto);
		const { cache: itemCache } = await createTestItemCache();
		const destroyKey = spyOn(crypto, "destroyKey");
		const setMasterUnlockKey = storage.setMasterUnlockKey.bind(storage);
		let accountId = "";
		spyOn(storage, "setMasterUnlockKey").mockImplementation(
			async (key, resolvedAccountId) => {
				accountId = resolvedAccountId ?? "";
				await setMasterUnlockKey(key, resolvedAccountId);
			},
		);
		spyOn(storage, "addAccount").mockImplementation(async () => {
			throw new Error("account metadata write failed");
		});

		const result = await loginResult(crypto);
		await expect(
			storeLoginSessionOwned(
				result,
				"secret",
				storage,
				itemCache,
				crypto,
				"user@example.com",
				{
					serverUrl: "https://cloud.example",
					createTravelModeRpcClient: (token: string | null) =>
						travelModeClientForToken(token, []),
				},
			),
		).rejects.toThrow("account metadata write failed");

		const cached = await storage.getMasterUnlockKey(accountId);
		expect(cached).toBe(result.masterUnlockKey);
		if (!cached) {
			throw new Error("transferred MUK was not cached");
		}
		expect(await crypto.exportKey(cached)).toEqual(MUK);
		expect(destroyKey).not.toHaveBeenCalled();
		expect(crypto.liveKeyCount).toBe(2);

		await storage.clearMasterUnlockKey(accountId);
		expect(crypto.liveKeyCount).toBe(1);
		await storage.clearAllStoredData();
		expect(crypto.liveKeyCount).toBe(0);
	});
});

describe("storeUnlockSession active account", () => {
	async function unlockResult(): Promise<UnlockResult> {
		return {
			mode: "local",
			token: "unlock-token",
			user: { id: "user-b", email: "same@example.com" },
			vaultKeys: [],
			masterUnlockKey: await mukRef(),
		};
	}

	async function seeded() {
		resetTravelModeEnforcerForTests();
		const { storage } = await makeStore([
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://b.example"),
		]);
		for (const accountId of ["account-a", "account-b"]) {
			await storage.storeTravelModeCache(
				{ enabled: false, hiddenVaultIds: [] },
				accountId,
			);
		}
		await storage.setActiveAccount("account-a");
		return { storage, itemCache: (await createTestItemCache()).cache };
	}

	it("leaves the active account alone when the caller opts out", async () => {
		const { storage, itemCache } = await seeded();

		await storeUnlockSession(
			await unlockResult(),
			storage,
			itemCache,
			"account-b",
			{
				setActive: false,
			},
		);

		expect(await storage.getActiveAccount()).toEqual("account-a");
	});

	it("claims the active account when the caller says nothing", async () => {
		const { storage, itemCache } = await seeded();

		await storeUnlockSession(
			await unlockResult(),
			storage,
			itemCache,
			"account-b",
		);

		expect(await storage.getActiveAccount()).toEqual("account-b");
	});
});
