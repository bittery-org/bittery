import type { KeyHandleLike } from "@bittery/crypto-wasm";
import type { CryptoPort, KeyRef } from "../crypto-port";
import { CryptoPortError } from "../errors";
import { createKeyRefTable, type KeyRefTable } from "../key-ref";
import {
	classify,
	loadCryptoWebBackend,
	memoizedBackendLoader,
	type UniffiBackend,
} from "../uniffi-bindings";

const FORWARDED_MEMBERS = [
	"initialize",
	"generateEncryptionKey",
	"importKey",
	"exportKey",
	"cloneKey",
	"destroyKey",
	"deriveKeys",
	"deriveMasterKey",
	"deriveKeysFromMasterKey",
	"deriveSrpPassword",
	"encrypt",
	"decrypt",
	"decryptMany",
	"wrapKey",
	"unwrapKey",
	"generateRsaKeyPair",
	"rsaEncrypt",
	"rsaDecrypt",
	"decryptRsaWrappedKey",
	"encryptVaultKeyForMember",
	"encryptVaultKeyWithMuk",
	"reEncryptItem",
	"performKeyRotation",
	"validateRotationData",
	"generateSecretKey",
	"validateSecretKey",
	"generateRecoveryKey",
	"validateRecoveryKey",
	"encryptMasterKey",
	"decryptMasterKey",
	"generateSrpRegistration",
	"generateClientEphemeral",
	"deriveClientSession",
	"verifyServerSession",
	"generatePasskeyKeypair",
	"generatePasskeyCredentialId",
	"buildPasskeyAttestationObject",
	"signPasskeyAssertion",
	"generateUuid",
] as const satisfies readonly (keyof CryptoPort)[];

type UnforwardedMember = Exclude<
	keyof CryptoPort,
	(typeof FORWARDED_MEMBERS)[number]
>;

/** Fails to compile when the port grows a member this adapter does not forward. */
export type EveryMemberIsForwarded = [UnforwardedMember] extends [never]
	? true
	: ["port member missing from FORWARDED_MEMBERS", UnforwardedMember];

export const everyMemberIsForwarded: EveryMemberIsForwarded = true;

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

/** Recursively swaps refs for handles while preserving raw import bytes and data records. */
function toHandle<Key extends object>(
	keys: KeyRefTable<Key>,
	value: unknown,
): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (value instanceof Uint8Array) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => toHandle(keys, item));
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, member]) => [
				key,
				toHandle(keys, member),
			]),
		);
	}
	return keys.read(value as KeyRef);
}

/** Mint a fresh `KeyRef` for every handle in a backend result; everything else is itself. */
function fromHandle<Key extends object>(
	keys: KeyRefTable<Key>,
	value: unknown,
): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (value instanceof Uint8Array) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => fromHandle(keys, item));
	}
	if (!isPlainObject(value)) {
		return keys.create(value as Key);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, member]) => [
			key,
			fromHandle(keys, member),
		]),
	);
}

/** How the WASM module is obtained. `wasm-test-doubles.ts` hands over an in-process one. */
export interface HandleCryptoPortDeps<Key = KeyHandleLike> {
	loadBackend: () => Promise<UniffiBackend<Key>>;
}

export type WasmCryptoPortDeps = HandleCryptoPortDeps;

export function createHandleCryptoPort<Key extends object>(
	deps: HandleCryptoPortDeps<Key>,
): CryptoPort {
	const keys = createKeyRefTable<Key>();
	const ensureBackend = memoizedBackendLoader(deps.loadBackend);

	async function call(
		method: keyof CryptoPort,
		args: readonly unknown[],
	): Promise<unknown> {
		const handled = args.map((arg) => toHandle(keys, arg));
		try {
			const backend = await ensureBackend();
			const member = backend[method] as unknown as (
				...args: readonly unknown[]
			) => Promise<unknown>;
			return fromHandle(keys, await member(...handled));
		} catch (error) {
			const { code, message } = classify(error);
			throw new CryptoPortError(code, message, { cause: error });
		}
	}

	const forwarded = Object.fromEntries(
		FORWARDED_MEMBERS.map((member) => [
			member,
			(...args: readonly unknown[]) => call(member, args),
		]),
	) as unknown as CryptoPort;

	return {
		...forwarded,

		// The ref table owns idempotency, so a second destroy never reaches the backend.
		async destroyKey(key) {
			const handle = keys.dispose(key);
			if (handle === null) {
				return;
			}
			try {
				const backend = await ensureBackend();
				await backend.destroyKey(handle);
			} catch (error) {
				const { code, message } = classify(error);
				throw new CryptoPortError(code, message, { cause: error });
			}
		},
	};
}

const DEFAULT_DEPS: HandleCryptoPortDeps = {
	loadBackend: loadCryptoWebBackend,
};

export function createWasmCryptoPort(
	deps: HandleCryptoPortDeps = DEFAULT_DEPS,
): CryptoPort {
	return createHandleCryptoPort(deps);
}
