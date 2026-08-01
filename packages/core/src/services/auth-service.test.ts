import { describe, expect, it, mock, spyOn } from "bun:test";
import type { AccountStore } from "@bittery/storage";
import type { InMemoryPlatformPort } from "@bittery/storage/testing";
import type { AccountMetadata } from "@bittery/storage/types";
import type { ICrypto, KdfProfile } from "@bittery/types";
import {
	createTestAccountStore,
	createTestItemCache,
} from "../testing/account-store-harness";
import {
	clearSession,
	deriveSrpLoginProof,
	getBiometricUnlockAvailability,
	type IAuthClient,
	type LoginResult,
	performSRPLogin,
	performSRPUnlock,
	storeLoginSession,
} from "./auth-service";
import { resetTravelModeEnforcerForTests } from "./travel-mode-enforcer";
import type { TravelModeRpcClient } from "./travel-mode-service";

const kdfParams: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

const MUK = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));

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
): Promise<{ storage: AccountStore; port: InMemoryPlatformPort }> {
	const { store, port } = await createTestAccountStore();
	for (const metadata of accounts) {
		await store.addAccount(metadata);
	}
	return { storage: store, port };
}

function createCrypto(secretReads: string[]): ICrypto {
	return {
		validateSecretKey: mock(async () => true),
		deriveKeys: mock(async (_password, secretKey, email) => {
			secretReads.push(`${secretKey}:${email}`);
			return {
				authKey: new TextEncoder().encode(`auth:${secretKey}`),
				masterUnlockKey: new Uint8Array([1, 2, 3]),
			};
		}),
		generateClientEphemeral: mock(async () => ({
			publicKey: "client-public",
			secret: "client-secret",
		})),
		deriveClientSession: mock(async () => ({ proof: "client-proof" })),
		verifyServerSession: mock(async () => {}),
		validateKdfProfile: mock(async () => {}),
	} as unknown as ICrypto;
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
				MUK,
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

		const secretReads: string[] = [];
		const clientAccountIds: string[] = [];
		const startedEmails: string[] = [];
		const getPinnedKdfProfile = spyOn(storage, "getPinnedKdfProfile");
		const crypto = createCrypto(secretReads);

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

		expect(secretReads).toEqual([
			"secret-account-a:same@example.com",
			"secret-account-b:same@example.com",
		]);
		expect(getPinnedKdfProfile.mock.calls).toEqual([
			["account-a"],
			["account-b"],
		]);
		expect(clientAccountIds).toEqual(["account-a", "account-b"]);
		expect(startedEmails).toEqual(["same@example.com", "same@example.com"]);
	});

	it("does not mutate storage or the active account before login commit", async () => {
		const { storage } = await makeStore([
			account("cloud", "cloud-user", "https://cloud.example"),
		]);
		await storage.setActiveAccount({ type: "single", accountId: "cloud" });

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
				secretKey: "secret",
				serverUrl: "https://self-hosted.example/",
			},
			{
				crypto: createCrypto([]),
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
		expect(await storage.getActiveAccount()).toEqual({
			type: "single",
			accountId: "cloud",
		});
		for (const write of Object.values(writes)) {
			expect(write).not.toHaveBeenCalled();
		}
	});

	it("validates full login against the pin selected by normalized server and email", async () => {
		const { storage } = await makeStore([
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://b.example"),
		]);
		const profileA = { ...kdfParams, iterations: 700_000 };
		const profileB = { ...kdfParams };
		await storage.storePinnedKdfProfile(profileA, "account-a");
		await storage.storePinnedKdfProfile(profileB, "account-b");
		const getPinnedKdfProfile = spyOn(storage, "getPinnedKdfProfile");
		const crypto = createCrypto([]);

		await performSRPLogin(
			{
				email: " SAME@example.com ",
				password: "password",
				secretKey: "secret",
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
		expect(crypto.validateKdfProfile).toHaveBeenCalledWith(kdfParams, profileB);
	});

	it("rejects a full-login downgrade before deriving keys", async () => {
		const crypto = createCrypto([]);
		delete (crypto as Partial<ICrypto>).validateKdfProfile;
		const deriveKeys = crypto.deriveKeys as ReturnType<typeof mock>;
		const { storage } = await makeStore([
			account("account-a", "user-a", "https://a.example"),
		]);
		await storage.storePinnedKdfProfile(
			{ ...kdfParams, iterations: 1_200_000 },
			"account-a",
		);

		expect(
			performSRPLogin(
				{
					email: "same@example.com",
					password: "password",
					secretKey: "secret",
					serverUrl: "https://a.example",
				},
				{ crypto, storage, authClient: createAuthClient([]) },
			),
		).rejects.toThrow("downgraded");
		expect(deriveKeys).not.toHaveBeenCalled();
	});

	it("rejects ambiguous full-login account matches before derivation", async () => {
		const crypto = createCrypto([]);
		const { storage } = await makeStore([
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://a.example/"),
		]);

		expect(
			performSRPLogin(
				{
					email: "same@example.com",
					password: "password",
					secretKey: "secret",
					serverUrl: "https://a.example",
				},
				{ crypto, storage, authClient: createAuthClient([]) },
			),
		).rejects.toThrow("Ambiguous account");
		expect(crypto.deriveKeys).not.toHaveBeenCalled();
	});
});

describe("KDF agility on unlock", () => {
	const pinnedProfile: KdfProfile = {
		schemaVersion: 1,
		algorithm: "pbkdf2-sha256",
		iterations: 600_000,
	};

	function createCapturingCrypto(derivedParams: KdfProfile[]) {
		return {
			validateSecretKey: mock(async () => true),
			deriveKeys: mock(
				async (
					_password: string,
					secretKey: string,
					_email: string,
					profile: KdfProfile,
				) => {
					derivedParams.push(profile);
					return {
						authKey: new TextEncoder().encode(`auth:${secretKey}`),
						masterUnlockKey: new Uint8Array([1, 2, 3]),
					};
				},
			),
			decrypt: mock(async () => "{}"),
			generateClientEphemeral: mock(async () => ({
				publicKey: "client-public",
				secret: "client-secret",
			})),
			deriveClientSession: mock(async () => ({ proof: "client-proof" })),
			verifyServerSession: mock(async () => {}),
			validateKdfProfile: mock(async () => {}),
		} as unknown as ICrypto;
	}

	it("derives unlock keys with the account's pinned KDF profile", async () => {
		const derivedParams: KdfProfile[] = [];
		const crypto = createCapturingCrypto(derivedParams);
		const { storage } = await makeStore([
			account("acct", "user", "https://acct.example"),
		]);
		await storage.storeSecretKey("secret", "acct");
		await storage.storePinnedKdfProfile(pinnedProfile, "acct");
		await storage.storeAuthToken("token", "acct");
		await storage.storeVaultKeys([], "acct");
		await storage.storeSessionData(MUK, "acct", "same@example.com", "user");

		const result = await performSRPUnlock(
			{ accountId: "acct", password: "password" },
			{
				crypto,
				storage,
				createAuthClientForAccount: async () => createAuthClient([]),
			},
		);

		expect(result.mode).toBe("local");
		expect(derivedParams).toHaveLength(1);
		expect(derivedParams[0]?.iterations).toBe(600_000);
	});

	it("requires full sign-in when the offline-unlock pin is missing", async () => {
		const crypto = createCapturingCrypto([]);
		const { storage } = await makeStore([
			account("acct", "user", "https://acct.example"),
		]);
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
		expect(crypto.deriveKeys).not.toHaveBeenCalled();
	});

	it("derives SRP login proofs with the negotiated server KDF params, not the current default", async () => {
		const derivedParams: KdfProfile[] = [];
		const crypto = createCapturingCrypto(derivedParams);
		const { storage } = await makeStore([
			account("acct", "user", "https://acct.example"),
		]);
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

		expect(derivedParams).toHaveLength(1);
		expect(derivedParams[0]?.iterations).toBe(600_000);
	});
});

describe("storeLoginSession travel mode verification", () => {
	function loginResult(): LoginResult {
		return {
			token: "fresh-login-token",
			sessionId: "session",
			expiresAt: new Date(Date.now() + 60_000),
			user: { id: "user-1", email: "user@example.com" },
			vaultKeys: [],
			masterUnlockKey: MUK,
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
			loginResult(),
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
			loginResult(),
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
			loginResult(),
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
});

/**
 * `AccountStore` holds only a `PlatformPort` and cannot reach the record cache, so
 * sign-out has to sequence the two clears here. Leaving the cache behind is the leak
 * CONTRACT.md §12.3 names — and lock is deliberately not sign-out.
 */
describe("clearSession item-cache handling", () => {
	async function seeded() {
		const { storage } = await makeStore();
		const { cache: itemCache } = await createTestItemCache();
		await storage.addAccount({
			accountId: "acc-1",
			email: "user@example.com",
			userId: "user-1",
			name: "User",
			serverUrl: "https://cloud.example",
			secretKeyHint: "ABCD",
			addedAt: 1,
			lastActiveAt: 1,
			biometricEnabled: false,
		});
		await storage.setActiveAccount({ type: "single", accountId: "acc-1" });
		await itemCache.setCachedItems(
			[{ id: "item-1", vaultId: "vault-1" } as never],
			"acc-1",
		);
		return { storage, itemCache };
	}

	it("wipes the account's cached ciphertext on a full sign-out", async () => {
		const { storage, itemCache } = await seeded();

		await clearSession(storage, itemCache, "acc-1", true);

		expect(await itemCache.getCachedItems("acc-1")).toBeNull();
	});

	it("resolves the active account when the caller has no id", async () => {
		const { storage, itemCache } = await seeded();

		await clearSession(storage, itemCache, undefined, true);

		expect(await itemCache.getCachedItems("acc-1")).toBeNull();
		// Never the `"default"` segment: that belongs to a different account
		// everywhere except web.
		expect(await itemCache.getCachedItems()).toBeNull();
	});

	it("keeps the cache on a lock, so quick-unlock stays cheap", async () => {
		const { storage, itemCache } = await seeded();

		await clearSession(storage, itemCache, "acc-1", false);

		expect(await itemCache.getCachedItems("acc-1")).toHaveLength(1);
	});
});
