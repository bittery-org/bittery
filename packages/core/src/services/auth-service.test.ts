import { describe, expect, it, mock } from "bun:test";
import type { IStorageAdapter } from "@bittery/storage";
import type { AccountMetadata } from "@bittery/storage/types";
import type { ICrypto, KdfParams } from "@bittery/types";
import {
	deriveSrpLoginProof,
	type IAuthClient,
	performSRPLogin,
} from "./auth-service";

const kdfParams: KdfParams = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 100_000,
	salt: "server-salt",
};

function account(accountId: string, userId: string, serverUrl: string): AccountMetadata {
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
		validateServerKdfParams: mock(async () => {}),
	} as unknown as ICrypto;
}

function createAuthClient(startedEmails: string[], token = "token"): IAuthClient {
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
			getStoredSecretKey: mock(async (accountId: string) => `secret-${accountId}`),
			getPinnedKdfParams: mock(async (accountId: string) => {
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
			storePinnedKdfParams: mock(async () => {}),
			setActiveAccount: mock(async () => {}),
		};
		const storage = {
			...writes,
			getAccountsList: mock(async () => [
				account("cloud", "cloud-user", "https://cloud.example"),
			]),
			getActiveAccount: mock(async () => ({ type: "single", accountId: "cloud" })),
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
});
