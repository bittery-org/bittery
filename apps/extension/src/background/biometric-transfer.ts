import type { VaultKeyData } from "@bittery/storage";
import type { EncryptedData } from "@bittery/types";
import { sendNativeMessage } from "./native-messaging-client";

export const BIOMETRIC_TRANSFER_FAILURE = {
	ACCOUNT_MISMATCH: "desktop-biometric-account-mismatch",
	MALFORMED_RESPONSE: "malformed-desktop-biometric-response",
	STALE_RESPONSE: "stale-desktop-unlock-response",
	TRANSPORT_FAILED: "desktop-biometric-transport-failed",
	UNEXPECTED_RESPONSE: "unexpected-desktop-biometric-response",
	UNLOCK_FAILED: "desktop-biometric-unlock-failed",
} as const;

export const STALE_DESKTOP_UNLOCK_RESPONSE =
	BIOMETRIC_TRANSFER_FAILURE.STALE_RESPONSE;

export type BiometricTransferFailureCode =
	(typeof BIOMETRIC_TRANSFER_FAILURE)[keyof typeof BIOMETRIC_TRANSFER_FAILURE];

export type BiometricAccountMaterial = {
	accountId: string;
	email: string;
	encryptedMuk: EncryptedData;
	deviceKey: Uint8Array;
	authToken?: string;
	vaultKeys?: VaultKeyData[];
};

export type SingleBiometricTransferResult =
	| { ok: true; material: BiometricAccountMaterial }
	| { ok: false; code: BiometricTransferFailureCode };

export type AllBiometricTransferResult =
	| { ok: true; materials: BiometricAccountMaterial[] }
	| { ok: false; code: BiometricTransferFailureCode };

type SingleDecoderInput = {
	accountId: string;
	challenge: string;
};

type AllDecoderInput = {
	expectedAccountIds: string[];
	challenge: string;
};

type SingleTransferInput = {
	accountId: string;
	extensionId: string;
};

type AllTransferInput = {
	expectedAccountIds: string[];
	extensionId: string;
};

type DecodeResult<T> = { ok: true; value: T } | { ok: false };

type RawAccountMaterial = Omit<BiometricAccountMaterial, "deviceKey">;

function failure<T extends BiometricTransferFailureCode>(
	code: T,
): {
	ok: false;
	code: T;
} {
	return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function optionalNonEmptyString(
	value: unknown,
): DecodeResult<string | undefined> {
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (nonEmptyString(value)) {
		return { ok: true, value };
	}
	return { ok: false };
}

function optionalStringOrNull(
	value: unknown,
): DecodeResult<string | null | undefined> {
	if (value === undefined || value === null) {
		return { ok: true, value };
	}
	if (typeof value === "string") {
		return { ok: true, value };
	}
	return { ok: false };
}

function parseJson(value: string): DecodeResult<unknown> {
	try {
		return { ok: true, value: JSON.parse(value) };
	} catch {
		return { ok: false };
	}
}

function decodeBase64(value: string): DecodeResult<Uint8Array> {
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes.length > 0 ? { ok: true, value: bytes } : { ok: false };
	} catch {
		return { ok: false };
	}
}

function decodeEncryptedMuk(value: unknown): DecodeResult<EncryptedData> {
	if (!nonEmptyString(value)) {
		return { ok: false };
	}

	const decoded = decodeBase64(value);
	if (!decoded.ok) {
		return decoded;
	}

	const parsed = parseJson(new TextDecoder().decode(decoded.value));
	if (!parsed.ok || !isRecord(parsed.value)) {
		return { ok: false };
	}

	const { algorithm, ciphertext, iv } = parsed.value;
	if (
		!nonEmptyString(algorithm) ||
		!nonEmptyString(ciphertext) ||
		!nonEmptyString(iv)
	) {
		return { ok: false };
	}

	return {
		ok: true,
		value: { algorithm, ciphertext, iv },
	};
}

function isVaultType(value: unknown): value is VaultKeyData["vaultType"] {
	return value === "personal" || value === "team";
}

function isVaultRole(value: unknown): value is VaultKeyData["role"] {
	return (
		value === "owner" ||
		value === "admin" ||
		value === "member" ||
		value === "read-only"
	);
}

function decodeVaultKey(value: unknown): DecodeResult<VaultKeyData> {
	if (!isRecord(value)) {
		return { ok: false };
	}

	const {
		encryptedVaultKey,
		role,
		vaultIcon,
		vaultId,
		vaultImageUrl,
		vaultName,
		vaultType,
	} = value;
	const decodedIcon = optionalStringOrNull(vaultIcon);
	const decodedImageUrl = optionalStringOrNull(vaultImageUrl);
	if (
		!nonEmptyString(encryptedVaultKey) ||
		!isVaultRole(role) ||
		!decodedIcon.ok ||
		!nonEmptyString(vaultId) ||
		!decodedImageUrl.ok ||
		!nonEmptyString(vaultName) ||
		!isVaultType(vaultType)
	) {
		return { ok: false };
	}

	return {
		ok: true,
		value: {
			encryptedVaultKey,
			role,
			...(decodedIcon.value === undefined
				? {}
				: { vaultIcon: decodedIcon.value }),
			vaultId,
			...(decodedImageUrl.value === undefined
				? {}
				: { vaultImageUrl: decodedImageUrl.value }),
			vaultName,
			vaultType,
		},
	};
}

function decodeVaultKeys(
	value: unknown,
): DecodeResult<VaultKeyData[] | undefined> {
	const encoded = optionalNonEmptyString(value);
	if (!encoded.ok) {
		return { ok: false };
	}
	if (encoded.value === undefined) {
		return { ok: true, value: undefined };
	}

	const parsed = parseJson(encoded.value);
	if (!parsed.ok || !Array.isArray(parsed.value)) {
		return { ok: false };
	}

	const vaultKeys: VaultKeyData[] = [];
	for (const entry of parsed.value) {
		const vaultKey = decodeVaultKey(entry);
		if (!vaultKey.ok) {
			return { ok: false };
		}
		vaultKeys.push(vaultKey.value);
	}
	return { ok: true, value: vaultKeys };
}

function decodeAccountMaterial(
	value: unknown,
): DecodeResult<RawAccountMaterial> {
	if (!isRecord(value)) {
		return { ok: false };
	}

	const {
		accountId,
		auth_token: authTokenValue,
		email,
		vault_keys: vaultKeysValue,
	} = value;
	const encryptedMuk = decodeEncryptedMuk(value.encrypted_session);
	const authToken = optionalNonEmptyString(authTokenValue);
	const vaultKeys = decodeVaultKeys(vaultKeysValue);
	if (
		!nonEmptyString(accountId) ||
		!authToken.ok ||
		!nonEmptyString(email) ||
		!encryptedMuk.ok ||
		!vaultKeys.ok
	) {
		return { ok: false };
	}

	return {
		ok: true,
		value: {
			accountId,
			email,
			encryptedMuk: encryptedMuk.value,
			...(authToken.value === undefined ? {} : { authToken: authToken.value }),
			...(vaultKeys.value === undefined ? {} : { vaultKeys: vaultKeys.value }),
		},
	};
}

function hasExpectedSignature(
	signature: unknown,
	challenge: string,
	boundTo: string | number,
): boolean {
	return signature === btoa(`${challenge}:${boundTo}`);
}

function strings(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === "string")
	);
}

export function decodeSingleBiometricTransferResponse(
	response: unknown,
	input: SingleDecoderInput,
): SingleBiometricTransferResult {
	if (!isRecord(response)) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}

	if (response.type === "BIOMETRIC_UNLOCK_FAILED") {
		return nonEmptyString(response.error)
			? failure(BIOMETRIC_TRANSFER_FAILURE.UNLOCK_FAILED)
			: failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}
	if (response.type !== "BIOMETRIC_UNLOCK_SUCCESS") {
		return failure(BIOMETRIC_TRANSFER_FAILURE.UNEXPECTED_RESPONSE);
	}

	if (
		!nonEmptyString(response.accountId) ||
		!nonEmptyString(response.device_key) ||
		!nonEmptyString(response.encrypted_session) ||
		!nonEmptyString(response.email) ||
		!nonEmptyString(response.signature)
	) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}
	if (
		!hasExpectedSignature(
			response.signature,
			input.challenge,
			response.encrypted_session,
		)
	) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.STALE_RESPONSE);
	}
	if (response.accountId !== input.accountId) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.ACCOUNT_MISMATCH);
	}

	const account = decodeAccountMaterial(response);
	const deviceKey = decodeBase64(response.device_key);
	if (!account.ok || !deviceKey.ok) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}

	return {
		ok: true,
		material: { ...account.value, deviceKey: deviceKey.value },
	};
}

export function decodeAllBiometricTransferResponse(
	response: unknown,
	input: AllDecoderInput,
): AllBiometricTransferResult {
	if (!isRecord(response)) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}

	if (response.type === "BIOMETRIC_UNLOCK_ALL_FAILED") {
		return nonEmptyString(response.error)
			? failure(BIOMETRIC_TRANSFER_FAILURE.UNLOCK_FAILED)
			: failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}
	if (response.type !== "BIOMETRIC_UNLOCK_ALL_SUCCESS") {
		return failure(BIOMETRIC_TRANSFER_FAILURE.UNEXPECTED_RESPONSE);
	}

	if (
		!nonEmptyString(response.device_key) ||
		!nonEmptyString(response.signature) ||
		!Array.isArray(response.accounts) ||
		!strings(response.failed) ||
		!strings(response.unlocked)
	) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}
	if (
		!hasExpectedSignature(
			response.signature,
			input.challenge,
			response.accounts.length,
		)
	) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.STALE_RESPONSE);
	}

	const deviceKey = decodeBase64(response.device_key);
	if (!deviceKey.ok) {
		return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
	}

	const expectedAccountIds = new Set(input.expectedAccountIds);
	const returnedAccountIds = new Set<string>();
	const materials: BiometricAccountMaterial[] = [];
	for (const entry of response.accounts) {
		const account = decodeAccountMaterial(entry);
		if (!account.ok) {
			return failure(BIOMETRIC_TRANSFER_FAILURE.MALFORMED_RESPONSE);
		}
		if (
			!expectedAccountIds.has(account.value.accountId) ||
			returnedAccountIds.has(account.value.accountId)
		) {
			return failure(BIOMETRIC_TRANSFER_FAILURE.ACCOUNT_MISMATCH);
		}
		returnedAccountIds.add(account.value.accountId);
		materials.push({ ...account.value, deviceKey: deviceKey.value });
	}

	return { ok: true, materials };
}

export async function requestSingleBiometricTransfer(
	input: SingleTransferInput,
): Promise<SingleBiometricTransferResult> {
	const challenge = crypto.randomUUID();
	try {
		const response = await sendNativeMessage({
			type: "BIOMETRIC_UNLOCK_REQUEST",
			challenge,
			extension_id: input.extensionId,
			accountId: input.accountId,
		});
		return decodeSingleBiometricTransferResponse(response, {
			accountId: input.accountId,
			challenge,
		});
	} catch {
		return failure(BIOMETRIC_TRANSFER_FAILURE.TRANSPORT_FAILED);
	}
}

export async function requestAllBiometricTransfer(
	input: AllTransferInput,
): Promise<AllBiometricTransferResult> {
	const challenge = crypto.randomUUID();
	try {
		const response = await sendNativeMessage({
			type: "BIOMETRIC_UNLOCK_ALL_REQUEST",
			challenge,
			extension_id: input.extensionId,
		});
		return decodeAllBiometricTransferResponse(response, {
			expectedAccountIds: input.expectedAccountIds,
			challenge,
		});
	} catch {
		return failure(BIOMETRIC_TRANSFER_FAILURE.TRANSPORT_FAILED);
	}
}
