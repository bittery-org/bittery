import type { CryptoPort, DecryptManyResult, KeyRef } from "./crypto-port";
import type { CryptoPortErrorCode } from "./errors";
import type {
	EncryptionContext,
	ItemData,
	SRPClientSession,
	TotpResult,
} from "./types";

export type CryptoUniffiBindings = Pick<
	typeof import("@bittery/crypto-wasm"),
	keyof CryptoPort
>;
export type LoadCryptoUniffi = () => Promise<CryptoUniffiBindings>;
type GeneratedKeyHandle = import("@bittery/crypto-wasm").KeyHandleLike;

type BoundValue<T, Key> = T extends KeyRef
	? Key
	: T extends Uint8Array
		? Uint8Array
		: T extends readonly (infer Item)[]
			? BoundValue<Item, Key>[]
			: T extends object
				? { [Property in keyof T]: BoundValue<T[Property], Key> }
				: T;

type BoundArgs<Args extends readonly unknown[], Key> = {
	[Position in keyof Args]: BoundValue<Args[Position], Key>;
};

export type UniffiBackend<Key = GeneratedKeyHandle> = {
	[Method in keyof CryptoPort]: (
		...args: BoundArgs<Parameters<CryptoPort[Method]>, Key>
	) => Promise<BoundValue<Awaited<ReturnType<CryptoPort[Method]>>, Key>>;
};

export class BackendFailure extends Error {
	readonly code: CryptoPortErrorCode;

	constructor(code: CryptoPortErrorCode, message: string) {
		super(message);
		this.name = "BackendFailure";
		this.code = code;
	}
}

/**
 * `CryptoError_Tags` from the generated bindings. Both the WASM and React Native generators
 * emit these same strings, and the table is duplicated here because this file must not import
 * either generated module at runtime — the React Native adapter shares it.
 *
 * A duplicated table can go stale, so the tag column is not `string`: `./types.drift-guard`
 * checks {@link UniffiErrorTag} against the generated `CryptoError_Tags` and fails the build
 * when a new Rust variant appears, rather than letting it fall through to the message
 * sniffing below.
 */
const UNIFFI_ERROR_TABLE = [
	["Decryption", "decryption-failed"],
	["KeyDestroyed", "key-destroyed"],
	["KeyHandleUnavailable", "invalid-key-ref"],
	["InvalidSessionProof", "verification-failed"],
	["InvalidPublicEphemeral", "verification-failed"],
	["InvalidInput", "invalid-input"],
	["InvalidKeyLength", "invalid-input"],
	["InvalidIvLength", "invalid-input"],
	["InvalidPem", "invalid-input"],
	["InvalidSecretKey", "invalid-input"],
	["Base64Decode", "invalid-input"],
	["HexDecode", "invalid-input"],
	["Utf8", "invalid-input"],
	["KeyDerivation", "backend-failure"],
	["Encryption", "backend-failure"],
	["Rsa", "backend-failure"],
	["Srp", "backend-failure"],
	["BackgroundTaskFailed", "backend-failure"],
] as const satisfies readonly (readonly [string, CryptoPortErrorCode])[];

/** Every `CryptoError` variant this file claims to translate. */
export type UniffiErrorTag = (typeof UNIFFI_ERROR_TABLE)[number][0];

const UNIFFI_ERROR_CODES: ReadonlyMap<string, CryptoPortErrorCode> = new Map(
	UNIFFI_ERROR_TABLE,
);

/** Single-string variants arrive as a frozen tuple, struct variants as a record, unit as nothing. */
function detail(inner: unknown): string {
	if (Array.isArray(inner)) {
		return inner.map((value) => String(value)).join(", ");
	}
	if (typeof inner === "object" && inner !== null) {
		return Object.entries(inner)
			.map(([field, value]) => `${field}=${String(value)}`)
			.join(", ");
	}
	return inner === undefined || inner === null ? "" : String(inner);
}

function classifyUniffi(
	error: unknown,
): { code: CryptoPortErrorCode; message: string } | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const { tag, inner } = error as { tag?: unknown; inner?: unknown };
	if (typeof tag !== "string") {
		return null;
	}
	const code = UNIFFI_ERROR_CODES.get(tag);
	if (code === undefined) {
		return null;
	}
	const text = detail(inner);
	return {
		code,
		message:
			text.length > 0 ? `CryptoError.${tag}: ${text}` : `CryptoError.${tag}`,
	};
}

const INVALID_INPUT_MARKERS = [
	"base64",
	"invalid input",
	"invalid key length",
	"invalid iv length",
	"invalid secret key format",
	"invalid pem format",
	"utf-8 decode",
	"invalid members json",
	"invalid items json",
	"invalid kdf",
] as const;

export function classify(error: unknown): {
	code: CryptoPortErrorCode;
	message: string;
} {
	if (error instanceof BackendFailure) {
		return { code: error.code, message: error.message };
	}

	const uniffi = classifyUniffi(error);
	if (uniffi !== null) {
		return uniffi;
	}

	const message = error instanceof Error ? error.message : String(error);
	const text = message.toLowerCase();
	if (text.includes("destroyed")) {
		return { code: "key-destroyed", message };
	}
	if (text.includes("key handle")) {
		return { code: "invalid-key-ref", message };
	}
	if (text.includes("decryption failed")) {
		return { code: "decryption-failed", message };
	}
	if (
		text.includes("invalid session proof") ||
		text.includes("invalid public ephemeral")
	) {
		return { code: "verification-failed", message };
	}
	if (INVALID_INPUT_MARKERS.some((marker) => text.includes(marker))) {
		return { code: "invalid-input", message };
	}
	return { code: "backend-failure", message };
}

function encryptionContext(
	value: NonNullable<Parameters<CryptoPort["encrypt"]>[2]>,
): UniffiEncryptionContext {
	return { ...value, version: BigInt(value.version) };
}

function context(
	value: Parameters<CryptoPort["encrypt"]>[2],
): UniffiEncryptionContext | undefined {
	return value === null ? undefined : encryptionContext(value);
}

function item(
	value: Parameters<CryptoPort["reEncryptItem"]>[0],
): UniffiItemData {
	return { ...value, context: encryptionContext(value.context) };
}

function bytes(value: ArrayBuffer): Uint8Array {
	return new Uint8Array(value);
}

function totpResult(value: UniffiTotpResult): TotpResult {
	return {
		code: value.code,
		remainingSeconds: Number(value.remainingSeconds),
		period: Number(value.period),
		progress: value.progress,
	};
}

/**
 * The FFI spelling of {@link EncryptionContext}. Stated as a difference from the canonical
 * type, not as a second field list: the generated record widens `version` to `bigint` (the
 * core takes a `u64`) and `entityType` to `string`, and everything else must stay in step.
 * {@link encryptionContext} performs exactly that conversion.
 */
export type UniffiEncryptionContext = Omit<
	EncryptionContext,
	"entityType" | "version"
> & {
	entityType: string;
	version: bigint;
};

/** {@link ItemData} carrying the widened context. */
export type UniffiItemData = Omit<ItemData, "context"> & {
	context: UniffiEncryptionContext;
};

/**
 * The FFI spelling of {@link TotpResult}: the core counts both spans of seconds in `u64`.
 * {@link totpResult} performs that conversion in the one direction it travels.
 */
export type UniffiTotpResult = Omit<
	TotpResult,
	"remainingSeconds" | "period"
> & {
	remainingSeconds: bigint;
	period: bigint;
};

export function createCryptoUniffiBackend(
	wasm: CryptoUniffiBindings,
): UniffiBackend {
	const sessions = new Map<string, SRPClientSession>();

	return {
		initialize: () => wasm.initialize(),
		generateEncryptionKey: () => wasm.generateEncryptionKey(),
		importKey: (key) => wasm.importKey(Uint8Array.from(key).buffer),
		async exportKey(key) {
			return bytes(await wasm.exportKey(key));
		},
		cloneKey: (key) => wasm.cloneKey(key),
		destroyKey: (key) => wasm.destroyKey(key),
		deriveKeys: (accountPassword, secretKey, email, profile) =>
			wasm.deriveKeys(accountPassword, secretKey, email, profile),
		deriveMasterKey: (accountPassword, secretKey, email, profile) =>
			wasm.deriveMasterKey(accountPassword, secretKey, email, profile),
		deriveKeysFromMasterKey: (masterKey, email) =>
			wasm.deriveKeysFromMasterKey(masterKey, email),
		deriveSrpPassword: (authKey) => wasm.deriveSrpPassword(authKey),
		encrypt: (plaintext, key, encryptionContext) =>
			wasm.encrypt(plaintext, key, context(encryptionContext)),
		decrypt: (data, key, encryptionContext) =>
			wasm.decrypt(data, key, context(encryptionContext)),
		async decryptMany(requests) {
			const results = await wasm.decryptMany(
				requests.map((request) => ({
					...request,
					context: context(request.context),
				})),
			);
			return results.map(
				(result: {
					id: string;
					plaintext?: string;
					error?: string;
				}): DecryptManyResult =>
					result.plaintext === undefined
						? {
								id: result.id,
								ok: false,
								error: result.error ?? "Decryption failed.",
							}
						: { id: result.id, ok: true, plaintext: result.plaintext },
			);
		},
		wrapKey: (key, wrappingKey, encryptionContext) =>
			wasm.wrapKey(key, wrappingKey, context(encryptionContext)),
		unwrapKey: (data, wrappingKey, encryptionContext) =>
			wasm.unwrapKey(data, wrappingKey, context(encryptionContext)),
		generateRsaKeyPair: () => wasm.generateRsaKeyPair(),
		rsaEncrypt: (plaintext, publicKeyPem) =>
			wasm.rsaEncrypt(plaintext, publicKeyPem),
		rsaDecrypt: (ciphertext, privateKeyPem) =>
			wasm.rsaDecrypt(ciphertext, privateKeyPem),
		decryptRsaWrappedKey: (
			ciphertext,
			encryptedPrivateKey,
			privateKeyWrappingKey,
			privateKeyContext,
		) =>
			wasm.decryptRsaWrappedKey(
				ciphertext,
				encryptedPrivateKey,
				privateKeyWrappingKey,
				context(privateKeyContext),
			),
		encryptVaultKeyForMember: (vaultKey, memberPublicKeyPem) =>
			wasm.encryptVaultKeyForMember(vaultKey, memberPublicKeyPem),
		encryptVaultKeyWithMuk: (
			vaultKey,
			masterUnlockKey,
			vaultId,
			userId,
			keyVersion,
		) =>
			wasm.encryptVaultKeyWithMuk(
				vaultKey,
				masterUnlockKey,
				vaultId,
				userId,
				BigInt(keyVersion),
			),
		reEncryptItem: (itemData, oldVaultKey, newVaultKey) =>
			wasm.reEncryptItem(item(itemData), oldVaultKey, newVaultKey),
		rewrapAttachmentKey: (
			encryptedAttachmentKey,
			oldVaultKey,
			newVaultKey,
			oldAttachmentContext,
			newAttachmentContext,
		) =>
			wasm.rewrapAttachmentKey(
				encryptedAttachmentKey,
				oldVaultKey,
				newVaultKey,
				encryptionContext(oldAttachmentContext),
				encryptionContext(newAttachmentContext),
			),
		generateSecretKey: () => wasm.generateSecretKey(),
		validateSecretKey: (secretKey) => wasm.validateSecretKey(secretKey),
		generateRecoveryKey: () => wasm.generateRecoveryKey(),
		validateRecoveryKey: (recoveryKey) => wasm.validateRecoveryKey(recoveryKey),
		encryptMasterKey: (masterKey, recoveryKey, email) =>
			wasm.encryptMasterKey(masterKey, recoveryKey, email),
		decryptMasterKey: (data, recoveryKey, email) =>
			wasm.decryptMasterKey(data, recoveryKey, email),
		generateSrpRegistration: (password) =>
			wasm.generateSrpRegistration(password),
		generateClientEphemeral: () => wasm.generateClientEphemeral(),
		async deriveClientSession(clientEphemeralSecret, challenge, password) {
			const session = await wasm.deriveClientSession(
				clientEphemeralSecret,
				challenge,
				password,
			);
			sessions.set(session.proof, session);
			return session;
		},
		async verifyServerSession(
			clientPublicEphemeral,
			session,
			serverSessionProof,
		) {
			const held = sessions.get(session.proof);
			if (held === undefined || held.key !== session.key) {
				throw new BackendFailure(
					"invalid-input",
					"This session was not derived by this crypto port.",
				);
			}
			await wasm.verifyServerSession(
				clientPublicEphemeral,
				held,
				serverSessionProof,
			);
			sessions.delete(session.proof);
		},
		generatePasskeyKeypair: () => wasm.generatePasskeyKeypair(),
		generatePasskeyCredentialId: () => wasm.generatePasskeyCredentialId(),
		async buildPasskeyAttestationObject(
			rpId,
			credentialIdBase64,
			cosePublicKeyBase64,
			signCount,
		) {
			const result = await wasm.buildPasskeyAttestationObject(
				rpId,
				credentialIdBase64,
				cosePublicKeyBase64,
				signCount,
			);
			return {
				authenticatorData: bytes(result.authenticatorData),
				attestationObject: bytes(result.attestationObject),
			};
		},
		async signPasskeyAssertion(
			privateKeyBase64,
			rpId,
			clientDataHashBase64,
			signCount,
		) {
			const result = await wasm.signPasskeyAssertion(
				privateKeyBase64,
				rpId,
				clientDataHashBase64,
				signCount,
			);
			return {
				authenticatorData: bytes(result.authenticatorData),
				signatureDer: bytes(result.signatureDer),
			};
		},
		async generateTotp(secret, algorithm, digits, period) {
			return totpResult(
				await wasm.generateTotp(secret, algorithm, digits, BigInt(period)),
			);
		},
		generateUuid: () => wasm.generateUuid(),
	};
}

export function memoizedBackendLoader<Key>(
	load: () => Promise<UniffiBackend<Key>>,
): () => Promise<UniffiBackend<Key>> {
	let backend: Promise<UniffiBackend<Key>> | null = null;
	return () => {
		backend ??= load().catch((error: unknown) => {
			backend = null;
			throw error;
		});
		return backend;
	};
}

export const loadCryptoWebBindings: LoadCryptoUniffi = async () => {
	const wasm = await import("@bittery/crypto-wasm");
	await wasm.uniffiInitAsync();
	return wasm as CryptoUniffiBindings;
};

export const loadCryptoWebBackend = async (): Promise<
	UniffiBackend<import("@bittery/crypto-wasm").KeyHandleLike>
> => createCryptoUniffiBackend(await loadCryptoWebBindings());

/** `@bittery/crypto-wasm` as a caller holds it after a static import. */
export type CryptoWasmModule = CryptoUniffiBindings &
	Pick<typeof import("@bittery/crypto-wasm"), "uniffiInitAsync">;

/**
 * A loader over a module the caller already imported.
 *
 * The HTML specification bans `import()` on `ServiceWorkerGlobalScope`, so an MV3
 * background cannot use {@link loadCryptoWebBackend}: the call throws and every crypto
 * operation in the worker fails with it. Such a caller imports the bindings statically
 * and comes through here. Instantiating the WASM binary stays lazy either way.
 */
export const staticCryptoBackend =
	(module: CryptoWasmModule) =>
	async (): Promise<
		UniffiBackend<import("@bittery/crypto-wasm").KeyHandleLike>
	> => {
		await module.uniffiInitAsync();
		return createCryptoUniffiBackend(module);
	};
