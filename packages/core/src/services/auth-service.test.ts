import { describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage";
import type { AccountMetadata } from "@bittery/storage/types";
import type { ICrypto, KdfProfile } from "@bittery/types";
import {
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
		const checkedAccountIds: string[] = [];
		const storage = {
			supportsBiometric: true,
			getAccountMetadata: mock(async (accountId: string) =>
				account(accountId, `user-${accountId}`, `https://${accountId}.example`),
			),
			isSessionValid: mock(async () => true),
			canQuickUnlock: mock(async () => true),
			canBiometricUnlock: mock(async (accountId: string) => {
				checkedAccountIds.push(accountId);
				return accountId === "account-b";
			}),
			isMasterPasswordReentryRequired: mock(async () => false),
			getStoredSessionData: mock(async () => null),
		} as unknown as IStorageAdapter;

		const availability = await getBiometricUnlockAvailability(storage, [
			"account-a",
			"account-b",
		]);

		expect(availability).toEqual({
			canUnlock: true,
			requiresPasswordReentry: false,
		});
		expect(checkedAccountIds).toEqual(["account-a", "account-b"]);
	});

	it("derives proofs for duplicate-email accounts from only the requested account", async () => {
		const accounts = [
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://b.example"),
		];
		const secretReads: string[] = [];
		const pinnedReads: string[] = [];
		const clientAccountIds: string[] = [];
		const startedEmails: string[] = [];
		const storage = {
			getAccountsList: mock(async () => accounts),
			getStoredSecretKey: mock(
				async (accountId: string) => `secret-${accountId}`,
			),
			getPinnedKdfProfile: mock(async (accountId: string) => {
				pinnedReads.push(accountId);
				return { ...kdfParams, salt: `pin-${accountId}` };
			}),
		} as unknown as IStorageAdapter;
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
		expect(pinnedReads).toEqual(["account-a", "account-b"]);
		expect(clientAccountIds).toEqual(["account-a", "account-b"]);
		expect(startedEmails).toEqual(["same@example.com", "same@example.com"]);
	});

	it("does not mutate storage or the active account before login commit", async () => {
		const writes = {
			storeAuthToken: mock(async () => {}),
			storeServerUrl: mock(async () => {}),
			storePinnedKdfProfile: mock(async () => {}),
			setActiveAccount: mock(async () => {}),
		};
		const storage = {
			...writes,
			getAccountsList: mock(async () => [
				account("cloud", "cloud-user", "https://cloud.example"),
			]),
			getActiveAccount: mock(async () => ({
				type: "single",
				accountId: "cloud",
			})),
		} as unknown as IStorageAdapter;
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
		const accounts = [
			account("account-a", "user-a", "https://a.example"),
			account("account-b", "user-b", "https://b.example"),
		];
		const profileA = { ...kdfParams, iterations: 700_000 };
		const profileB = { ...kdfParams };
		const crypto = createCrypto([]);
		const storage = {
			getAccountsList: mock(async () => accounts),
			getPinnedKdfProfile: mock(async (accountId: string) =>
				accountId === "account-a" ? profileA : profileB,
			),
		} as unknown as IStorageAdapter;

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

		expect(storage.getPinnedKdfProfile).toHaveBeenCalledWith("account-b");
		expect(crypto.validateKdfProfile).toHaveBeenCalledWith(
			kdfParams,
			profileB,
		);
	});

	it("rejects a full-login downgrade before deriving keys", async () => {
		const crypto = createCrypto([]);
		delete (crypto as Partial<ICrypto>).validateKdfProfile;
		const deriveKeys = crypto.deriveKeys as ReturnType<typeof mock>;
		const storage = {
			getAccountsList: mock(async () => [
				account("account-a", "user-a", "https://a.example"),
			]),
			getPinnedKdfProfile: mock(async () => ({
				...kdfParams,
				iterations: 1_200_000,
			})),
		} as unknown as IStorageAdapter;

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
		const storage = {
			getAccountsList: mock(async () => [
				account("account-a", "user-a", "https://a.example"),
				account("account-b", "user-b", "https://a.example/"),
			]),
		} as unknown as IStorageAdapter;

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
		const storage = {
			getAccountsList: mock(async () => [
				account("acct", "user", "https://acct.example"),
			]),
			getStoredSecretKey: mock(async () => "secret"),
			getPinnedKdfProfile: mock(async () => pinnedProfile),
			getEncryptedPrivateKey: mock(async () => null),
			getStoredSessionData: mock(async () => ({
				sessionId: "session",
				expiresAt: Date.now() + 60_000,
				userId: "user",
				email: "same@example.com",
			})),
			getAuthToken: mock(async () => "token"),
			getVaultKeys: mock(async () => []),
			isSessionValid: mock(async () => true),
			getAccountMetadata: mock(async () =>
				account("acct", "user", "https://acct.example"),
			),
		} as unknown as IStorageAdapter;

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
		const storage = {
			getAccountsList: mock(async () => [
				account("acct", "user", "https://acct.example"),
			]),
			getStoredSecretKey: mock(async () => "secret"),
			getPinnedKdfProfile: mock(async () => null),
		} as unknown as IStorageAdapter;

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
		const storage = {
			getAccountsList: mock(async () => [
				account("acct", "user", "https://acct.example"),
			]),
			getStoredSecretKey: mock(async () => "secret"),
			getPinnedKdfProfile: mock(async () => pinnedProfile),
		} as unknown as IStorageAdapter;

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
			masterUnlockKey: new Uint8Array([1, 2, 3]),
			kdfParams,
			serverUrl: "https://cloud.example",
		};
	}

	function createStorage(): IStorageAdapter {
		// No auth token is stored yet — this is a first login in a fresh browser,
		// so any ambient RPC client reading storage is unauthenticated.
		return {
			getAccountsList: mock(async () => []),
			getAuthToken: mock(async () => null),
			getServerUrl: mock(async () => "https://cloud.example"),
			getTravelModeCache: mock(async () => null),
			storeTravelModeCache: mock(async () => {}),
			getPinnedKdfProfile: mock(async () => null),
			storePinnedKdfProfile: mock(async () => {}),
			storeAuthToken: mock(async () => {}),
			storeServerUrl: mock(async () => {}),
			storeVaultKeys: mock(async () => {}),
			getVaultKeys: mock(async () => []),
			storeSecretKey: mock(async () => {}),
			storeSessionData: mock(async () => {}),
			setMasterUnlockKey: mock(async () => {}),
			storeEncryptedPrivateKey: mock(async () => {}),
		} as unknown as IStorageAdapter;
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
		const storage = createStorage();
		const seenTokens: (string | null)[] = [];

		await storeLoginSession(
			loginResult(),
			"secret",
			storage,
			"user@example.com",
			{
				serverUrl: "https://cloud.example",
				createTravelModeRpcClient: (token) =>
					travelModeClientForToken(token, seenTokens),
			},
		);

		expect(seenTokens).toEqual(["fresh-login-token"]);
		expect(storage.storePinnedKdfProfile).toHaveBeenCalledWith(
			kdfParams,
			expect.any(String),
		);
	});
});
