import type { CryptoPort, DecryptManyResult, KeyRef } from "./crypto-port";
import type { CryptoPortErrorCode } from "./errors";

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

function context(
	value: Parameters<CryptoPort["encrypt"]>[2],
): UniffiEncryptionContext | undefined {
	return value === null
		? undefined
		: { ...value, version: BigInt(value.version) };
}

function bytes(value: ArrayBuffer): Uint8Array {
	return new Uint8Array(value);
}

type UniffiEncryptionContext = {
	vaultId: string;
	entityId: string;
	entityType: string;
	version: bigint;
	userId: string;
};

export function createCryptoUniffiBackend(
	wasm: CryptoUniffiBindings,
): UniffiBackend {
	const sessions = new Map<string, import("@bittery/types").SRPClientSession>();

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
		wrapKey: (key, wrappingKey) => wasm.wrapKey(key, wrappingKey),
		unwrapKey: (data, wrappingKey, options) =>
			wasm.unwrapKey(
				data,
				wrappingKey,
				options ? context(options.context) : undefined,
				options?.legacyEnvelope?.marker,
				options?.legacyEnvelope?.context,
			),
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
		reEncryptItem: (item, oldVaultKey, newVaultKey) =>
			wasm.reEncryptItem(item, oldVaultKey, newVaultKey),
		performKeyRotation: (
			oldVaultKey,
			members,
			items,
			vaultId,
			keyVersion,
			currentUserId,
			masterUnlockKey,
		) =>
			wasm.performKeyRotation(
				oldVaultKey,
				[...members],
				[...items],
				vaultId,
				BigInt(keyVersion),
				currentUserId,
				masterUnlockKey,
			),
		validateRotationData: (members) => wasm.validateRotationData([...members]),
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
