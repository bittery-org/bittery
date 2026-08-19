import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

const backgroundDir = path.resolve(import.meta.dir, "../../src/background");

const CHALLENGE = "11111111-2222-3333-4444-555555555555";
const ACCOUNT_ID = "account-1";
const OTHER_ACCOUNT_ID = "account-2";
const ENCRYPTED_SESSION = btoa(
	JSON.stringify({
		ciphertext: "ciphertext",
		iv: "initialization-vector",
		algorithm: "AES-GCM-AAD-V1",
	}),
);

let nativeResponse: unknown;
let nativeTransportError: Error | null = null;
const sentMessages: unknown[] = [];

mock.module(path.join(backgroundDir, "native-messaging-client.ts"), () => ({
	sendNativeMessage: async (message: unknown) => {
		sentMessages.push(message);
		if (nativeTransportError) {
			throw nativeTransportError;
		}
		return nativeResponse;
	},
}));

const {
	BIOMETRIC_TRANSFER_FAILURE,
	decodeAllBiometricTransferResponse,
	decodeSingleBiometricTransferResponse,
	requestAllBiometricTransfer,
	requestSingleBiometricTransfer,
} = await import(path.join(backgroundDir, "biometric-transfer.ts"));

function vaultKeys(): string {
	return JSON.stringify([
		{
			vaultId: "vault-1",
			vaultName: "Personal",
			vaultType: "personal",
			encryptedVaultKey: "encrypted-key",
			role: "owner",
		},
	]);
}

function accountMaterial(accountId: string): Record<string, unknown> {
	return {
		accountId,
		email: `${accountId}@example.com`,
		encrypted_session: ENCRYPTED_SESSION,
		auth_token: `token-${accountId}`,
		vault_keys: vaultKeys(),
	};
}

function singleSuccess(accountId = ACCOUNT_ID): Record<string, unknown> {
	return {
		type: "BIOMETRIC_UNLOCK_SUCCESS",
		...accountMaterial(accountId),
		device_key: btoa("device-key"),
		signature: btoa(`${CHALLENGE}:${ENCRYPTED_SESSION}`),
	};
}

function allSuccess(
	accountIds = [ACCOUNT_ID, OTHER_ACCOUNT_ID],
): Record<string, unknown> {
	return {
		type: "BIOMETRIC_UNLOCK_ALL_SUCCESS",
		device_key: btoa("device-key"),
		signature: btoa(`${CHALLENGE}:${accountIds.length}`),
		accounts: accountIds.map(accountMaterial),
		unlocked: accountIds,
		failed: [],
	};
}

beforeEach(() => {
	nativeResponse = singleSuccess();
	nativeTransportError = null;
	sentMessages.length = 0;
	crypto.randomUUID = () => CHALLENGE as ReturnType<typeof crypto.randomUUID>;
});

describe("single biometric transfer", () => {
	test("creates a challenge, dispatches the typed request, and extracts material", async () => {
		const result = await requestSingleBiometricTransfer({
			accountId: ACCOUNT_ID,
			extensionId: "extension-id",
		});

		expect(sentMessages).toEqual([
			{
				type: "BIOMETRIC_UNLOCK_REQUEST",
				challenge: CHALLENGE,
				extension_id: "extension-id",
				accountId: ACCOUNT_ID,
			},
		]);
		expect(result).toMatchObject({
			ok: true,
			material: {
				accountId: ACCOUNT_ID,
				email: `${ACCOUNT_ID}@example.com`,
				authToken: `token-${ACCOUNT_ID}`,
				vaultKeys: [
					{
						vaultId: "vault-1",
						vaultType: "personal",
						role: "owner",
					},
				],
			},
		});
		if (result.ok) {
			expect([...result.material.deviceKey]).toEqual([
				...new TextEncoder().encode("device-key"),
			]);
		}
	});

	test("rejects malformed material with a stable failure code", () => {
		const malformed = singleSuccess();
		malformed.encrypted_session = btoa(JSON.stringify({ ciphertext: "only" }));
		malformed.signature = btoa(`${CHALLENGE}:${malformed.encrypted_session}`);

		expect(
			decodeSingleBiometricTransferResponse(malformed, {
				accountId: ACCOUNT_ID,
				challenge: CHALLENGE,
			}),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE,
		});
	});

	test("rejects a response bound to another challenge", () => {
		const stale = singleSuccess();
		stale.signature = btoa(`another-challenge:${ENCRYPTED_SESSION}`);

		expect(
			decodeSingleBiometricTransferResponse(stale, {
				accountId: ACCOUNT_ID,
				challenge: CHALLENGE,
			}),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.STALE_RESPONSE,
		});
	});

	test("rejects material for another account", () => {
		expect(
			decodeSingleBiometricTransferResponse(singleSuccess(OTHER_ACCOUNT_ID), {
				accountId: ACCOUNT_ID,
				challenge: CHALLENGE,
			}),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.ACCOUNT_MISMATCH,
		});
	});

	test("normalizes host failures to typed codes", () => {
		expect(
			decodeSingleBiometricTransferResponse(
				{ type: "BIOMETRIC_UNLOCK_FAILED", error: "host detail" },
				{ accountId: ACCOUNT_ID, challenge: CHALLENGE },
			),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.UNLOCK_FAILED,
		});
	});

	test("normalizes transport failures to typed codes", async () => {
		nativeTransportError = new Error("native host disconnected");

		await expect(
			requestSingleBiometricTransfer({
				accountId: ACCOUNT_ID,
				extensionId: "extension-id",
			}),
		).resolves.toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.TRANSPORT_FAILED,
		});
	});
});

describe("all-account biometric transfer", () => {
	test("extracts material for each expected account", async () => {
		nativeResponse = allSuccess();

		const result = await requestAllBiometricTransfer({
			expectedAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
			extensionId: "extension-id",
		});

		expect(sentMessages).toEqual([
			{
				type: "BIOMETRIC_UNLOCK_ALL_REQUEST",
				challenge: CHALLENGE,
				extension_id: "extension-id",
			},
		]);
		expect(result).toMatchObject({
			ok: true,
			materials: [
				{ accountId: ACCOUNT_ID, authToken: `token-${ACCOUNT_ID}` },
				{ accountId: OTHER_ACCOUNT_ID, authToken: `token-${OTHER_ACCOUNT_ID}` },
			],
		});
	});

	test("rejects a response containing an account not held by the extension", () => {
		expect(
			decodeAllBiometricTransferResponse(allSuccess([ACCOUNT_ID, "unknown"]), {
				expectedAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
				challenge: CHALLENGE,
			}),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.ACCOUNT_MISMATCH,
		});
	});

	test("rejects malformed material in an all-account response", () => {
		const malformed = allSuccess([ACCOUNT_ID]);
		malformed.accounts = [{ accountId: ACCOUNT_ID }];
		malformed.signature = btoa(`${CHALLENGE}:1`);

		expect(
			decodeAllBiometricTransferResponse(malformed, {
				expectedAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
				challenge: CHALLENGE,
			}),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE,
		});
	});

	test("rejects an all-account response bound to another challenge", () => {
		const stale = allSuccess();
		stale.signature = btoa("another-challenge:2");

		expect(
			decodeAllBiometricTransferResponse(stale, {
				expectedAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
				challenge: CHALLENGE,
			}),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.STALE_RESPONSE,
		});
	});

	test("normalizes all-account host failures to typed codes", () => {
		expect(
			decodeAllBiometricTransferResponse(
				{ type: "BIOMETRIC_UNLOCK_ALL_FAILED", error: "host detail" },
				{
					expectedAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
					challenge: CHALLENGE,
				},
			),
		).toEqual({
			ok: false,
			code: BIOMETRIC_TRANSFER_FAILURE.UNLOCK_FAILED,
		});
	});
});
