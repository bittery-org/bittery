/**
 * The `@bittery/crypto-wasm` binding surface, and the pure marshalling from it onto a
 * bigint-handle-keyed `CryptoPort` — shared by both of web's real adapters over that one
 * binding: the worker (`wasm.worker.ts` drives this from inside a `Worker`) and the
 * extension's same-thread adapter (`adapters/wasm.ts`, no worker, no `postMessage`).
 *
 * Both bind the identical package and both hold a `KeyRef`'s payload as one of its
 * `bigint` handles, so argument order, base64 boundaries, the JSON envelope shapes
 * (`encryptVaultKeyWithMuk`, key rotation) and error translation are the same problem in
 * both places. What differs — whether a handle then crosses a thread boundary as a wire
 * value or simply gets read back out of the same key table — is each adapter's own
 * concern and stays in each adapter's own file, not here.
 *
 * ## What crosses back
 *
 * A failure crosses as a `CryptoPortErrorCode` plus a message. `classify` is the one place
 * WASM's error vocabulary meets the port's: the strings it matches are the `Display`
 * output of `bittery_crypto_core::CryptoError`, so a change there is what would move a
 * failure into `backend-failure`.
 */

import type {
	EncryptedData,
	EncryptionContext,
	ItemData,
	MemberEncryptedKey,
	MemberKeyData,
	ReEncryptedItem,
} from "@bittery/types";
import type { WasmWorkerBackend } from "./adapters/wasm-worker";
import type { CryptoPortErrorCode } from "./errors";

// ============================================================================
// `@bittery/crypto-wasm`, as this backend uses it
// ============================================================================

/**
 * The slice of the WASM binding this file calls, declared structurally so a test can run
 * the real marshalling over a double.
 *
 * The real module is not merely *assumed* to match: `loadCryptoWasm` returns the imported
 * namespace as a `CryptoWasm`, so the compiler compares this declaration against
 * `bittery_crypto.d.ts` on every build. Members are written in wasm-bindgen's own
 * snake_case, and the names are its `js_name`s, so the two can be read side by side.
 */
export interface CryptoWasm {
	JsAadContext: new (
		vaultId: string,
		entityId: string,
		entityType: string,
		version: bigint,
		userId: string,
	) => WasmAadContext;
	JsEncryptedData: new (
		ciphertext: string,
		iv: string,
		algorithm: string,
	) => WasmEncryptedData;
	JsItemData: new (
		id: string,
		encryptedData: string,
		encryptionIv: string,
		encryptionAlgorithm: string,
	) => WasmItemData;
	JsSrpClient: new (hashAlgorithm: string, primeGroup: number) => WasmSrpClient;

	importKeyHandle(keyBase64: string): bigint;
	exportKeyHandle(keyHandle: bigint): string;
	cloneKeyHandle(keyHandle: bigint): bigint;
	destroyKeyHandle(keyHandle: bigint): boolean;
	generateEncryptionKey(): string;

	deriveKeysHandle(
		accountPassword: string,
		secretKey: string,
		email: string,
		schemaVersion: number,
		algorithm: string,
		iterations: number,
	): WasmDerivedKeyHandles;
	deriveMasterKeyHandle(
		accountPassword: string,
		secretKey: string,
		email: string,
		schemaVersion: number,
		algorithm: string,
		iterations: number,
	): bigint;
	deriveKeysFromMasterKeyHandle(
		masterKeyHandle: bigint,
		email: string,
	): WasmDerivedKeyHandles;
	deriveSrpPasswordFromHandle(authKeyHandle: bigint): string;

	encryptWithHandle(plaintext: string, keyHandle: bigint): WasmEncryptedData;
	encryptWithContextHandle(
		plaintext: string,
		keyHandle: bigint,
		context: WasmAadContext,
	): WasmEncryptedData;
	decryptWithHandle(data: WasmEncryptedData, keyHandle: bigint): string;
	decryptWithContextHandle(
		data: WasmEncryptedData,
		keyHandle: bigint,
		context: WasmAadContext,
	): string;
	encryptKeyHandleWithKey(
		keyHandle: bigint,
		wrappingKeyBase64: string,
	): WasmEncryptedData;
	decryptKeyHandleWithKey(
		data: WasmEncryptedData,
		wrappingKeyBase64: string,
	): bigint;

	generateRSAKeyPair(): WasmRsaKeyPair;
	rsaEncrypt(plaintext: string, publicKeyPem: string): string;
	rsaDecrypt(ciphertext: string, privateKeyPem: string): string;

	encryptVaultKeyForMember(
		vaultKeyBase64: string,
		memberPublicKey: string,
	): string;
	encryptVaultKeyWithMUK(
		vaultKeyBase64: string,
		masterUnlockKeyBase64: string,
		vaultId: string,
		userId: string,
		keyVersion: bigint,
	): string;
	reEncryptItem(
		item: WasmItemData,
		oldVaultKeyBase64: string,
		newVaultKeyBase64: string,
	): WasmReEncryptedItem;
	performKeyRotation(
		oldVaultKeyBase64: string,
		membersJson: string,
		itemsJson: string,
		vaultId: string,
		keyVersion: bigint,
		currentUserId: string,
		masterUnlockKeyBase64: string,
	): WasmKeyRotationResult;
	validateRotationData(membersJson: string): WasmValidationResult;

	generateSecretKey(): string;
	validateSecretKey(secretKey: string): boolean;
	generateRecoveryKey(): string;
	validateRecoveryKey(recoveryKey: string): boolean;
	encryptMasterKey(
		masterKeyBase64: string,
		recoveryKey: string,
		email: string,
	): WasmEncryptedData;
	decryptMasterKey(
		data: WasmEncryptedData,
		recoveryKey: string,
		email: string,
	): string;

	generatePasskeyKeypair(): WasmPasskeyKeypair;
	generatePasskeyCredentialId(): string;
	buildPasskeyAttestationObject(
		rpId: string,
		credentialIdBase64: string,
		cosePublicKeyBase64: string,
		signCount: number,
	): WasmPasskeyAttestation;
	signPasskeyAssertion(
		privateKeyBase64: string,
		rpId: string,
		clientDataHashBase64: string,
		signCount: number,
	): WasmPasskeyAssertion;

	generateUuid(): string;
}

export interface WasmAadContext {
	vault_id: string;
	entity_id: string;
	entity_type: string;
	version: bigint;
	user_id: string;
}

export interface WasmEncryptedData {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

export interface WasmItemData {
	id: string;
	encrypted_data: string;
	encryption_iv: string;
	encryption_algorithm: string;
}

export interface WasmDerivedKeyHandles {
	auth_key_handle: bigint;
	master_unlock_key_handle: bigint;
}

export interface WasmRsaKeyPair {
	public_key: string;
	private_key: string;
}

export interface WasmReEncryptedItem {
	item_id: string;
	encrypted_data: string;
	encryption_iv: string;
}

export interface WasmKeyRotationResult {
	getMemberEncryptedKeys(): unknown;
	getReEncryptedItems(): unknown;
}

export interface WasmValidationResult {
	valid: boolean;
	getErrors(): unknown;
}

export interface WasmPasskeyKeypair {
	private_key: string;
	public_key_cose: string;
}

export interface WasmPasskeyAttestation {
	authenticator_data: string;
	attestation_object: string;
}

export interface WasmPasskeyAssertion {
	authenticator_data: string;
	signature_der: string;
}

export interface WasmSrpEphemeral {
	public: string;
	secret: string;
}

export interface WasmSrpSession {
	key: string;
	proof: string;
}

export interface WasmSrpClient {
	generateSalt(): string;
	deriveSafePrivateKey(salt: string, password: string): string;
	deriveVerifier(privateKey: string): string;
	generateEphemeral(): WasmSrpEphemeral;
	deriveSession(
		clientSecretEphemeral: string,
		serverPublicEphemeral: string,
		salt: string,
		username: string,
		privateKey: string,
	): WasmSrpSession;
	verifySession(
		clientPublicEphemeral: string,
		session: WasmSrpSession,
		serverSessionProof: string,
	): void;
}

/** How the WASM module is obtained. The test doubles hand over an in-process one. */
export type LoadCryptoWasm = () => Promise<CryptoWasm>;

// ============================================================================
// Failures
// ============================================================================

/** A failure raised by a caller of this backend, already carrying its port code. */
export class BackendFailure extends Error {
	readonly code: CryptoPortErrorCode;

	constructor(code: CryptoPortErrorCode, message: string) {
		super(message);
		this.name = "BackendFailure";
		this.code = code;
	}
}

/**
 * Malformed argument, in the vocabulary of `CryptoError`'s `Display`. Matched in lower
 * case, and `decryption failed` is tested first so `RSA operation failed: Decryption
 * failed: …` lands on the code that describes it.
 */
const INVALID_INPUT_MARKERS = [
	"invalid input",
	"invalid pem",
	"base64 decode",
	"hex decode",
	"invalid key length",
	"invalid iv length",
	"invalid secret key format",
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
	// A wasm-bindgen panic, a module that failed to instantiate, an out-of-memory: the
	// backend rather than the call.
	return { code: "backend-failure", message };
}

// ============================================================================
// base64
// ============================================================================

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

// ============================================================================
// The backend
// ============================================================================

/** Matches what every other Bittery client has always negotiated with. */
const SRP_HASH_ALGORITHM = "SHA-256";
const SRP_PRIME_GROUP = 4096;

/**
 * `CryptoPort`, marshalled onto `wasm`, with a WASM key-table handle where a `KeyRef`
 * would be. Neither caller here knows about `KeyRef` at all — that translation is each
 * adapter's own job, done by walking arguments and results through its own `KeyRef` table.
 */
export function createCryptoWasmBackend(wasm: CryptoWasm): WasmWorkerBackend {
	const srp = new wasm.JsSrpClient(SRP_HASH_ALGORITHM, SRP_PRIME_GROUP);

	// `verifySession` needs the session object the binding produced, not a copy of its two
	// fields, so the one that crossed the seam as data is looked back up by its proof.
	const sessions = new Map<string, WasmSrpSession>();

	function aad(context: EncryptionContext | null): WasmAadContext | null {
		if (context === null) {
			return null;
		}
		return new wasm.JsAadContext(
			context.vaultId,
			context.entityId,
			context.entityType,
			BigInt(context.version),
			context.userId,
		);
	}

	function sealed(data: EncryptedData): WasmEncryptedData {
		return new wasm.JsEncryptedData(data.ciphertext, data.iv, data.algorithm);
	}

	function plain(data: WasmEncryptedData): EncryptedData {
		return {
			ciphertext: data.ciphertext,
			iv: data.iv,
			algorithm: data.algorithm,
		};
	}

	function open(
		data: EncryptedData,
		key: bigint,
		context: EncryptionContext | null,
	): string {
		const bound = aad(context);
		return bound === null
			? wasm.decryptWithHandle(sealed(data), key)
			: wasm.decryptWithContextHandle(sealed(data), key, bound);
	}

	function membersJson(members: readonly MemberKeyData[]): string {
		return JSON.stringify(
			members.map((member) => ({
				user_id: member.userId,
				public_key: member.publicKey,
			})),
		);
	}

	function itemsJson(items: readonly ItemData[]): string {
		return JSON.stringify(
			items.map((item) => ({
				id: item.id,
				encrypted_data: item.encryptedData,
				encryption_iv: item.encryptionIv,
				encryption_algorithm: item.encryptionAlgorithm,
			})),
		);
	}

	function reEncrypted(item: WasmReEncryptedItem): ReEncryptedItem {
		return {
			itemId: item.item_id,
			encryptedData: item.encrypted_data,
			encryptionIv: item.encryption_iv,
		};
	}

	return {
		// Every caller of this backend loads WASM before running any member, so being
		// ready is all `initialize` has to report.
		async initialize() {},

		// ------------------------------------------------------------------
		// Key lifecycle
		// ------------------------------------------------------------------

		async generateEncryptionKey() {
			return wasm.importKeyHandle(wasm.generateEncryptionKey());
		},

		async importKey(key) {
			return wasm.importKeyHandle(toBase64(key));
		},

		async exportKey(key) {
			return fromBase64(wasm.exportKeyHandle(key));
		},

		async cloneKey(key) {
			return wasm.cloneKeyHandle(key);
		},

		async destroyKey(key) {
			wasm.destroyKeyHandle(key);
		},

		// ------------------------------------------------------------------
		// Derivation
		// ------------------------------------------------------------------

		async deriveKeys(accountPassword, secretKey, email, profile) {
			const handles = wasm.deriveKeysHandle(
				accountPassword,
				secretKey,
				email,
				profile.schemaVersion,
				profile.algorithm,
				profile.iterations,
			);
			return {
				authKey: handles.auth_key_handle,
				masterUnlockKey: handles.master_unlock_key_handle,
			};
		},

		async deriveMasterKey(accountPassword, secretKey, email, profile) {
			return wasm.deriveMasterKeyHandle(
				accountPassword,
				secretKey,
				email,
				profile.schemaVersion,
				profile.algorithm,
				profile.iterations,
			);
		},

		async deriveKeysFromMasterKey(masterKey, email) {
			const handles = wasm.deriveKeysFromMasterKeyHandle(masterKey, email);
			return {
				authKey: handles.auth_key_handle,
				masterUnlockKey: handles.master_unlock_key_handle,
			};
		},

		async deriveSrpPassword(authKey) {
			return wasm.deriveSrpPasswordFromHandle(authKey);
		},

		// ------------------------------------------------------------------
		// Symmetric encryption
		// ------------------------------------------------------------------

		async encrypt(plaintext, key, context) {
			const bound = aad(context);
			return plain(
				bound === null
					? wasm.encryptWithHandle(plaintext, key)
					: wasm.encryptWithContextHandle(plaintext, key, bound),
			);
		},

		async decrypt(data, key, context) {
			return open(data, key, context);
		},

		async decryptMany(requests) {
			// A straightforward loop: nothing amortises across a batch here, because there
			// is no round trip to save — that only matters for the worker, one file over.
			return requests.map((request) => {
				try {
					return {
						id: request.id,
						ok: true as const,
						plaintext: open(request.data, request.key, request.context),
					};
				} catch (error) {
					return {
						id: request.id,
						ok: false as const,
						error: classify(error).message,
					};
				}
			});
		},

		async wrapKey(key, wrappingKey) {
			return plain(
				wasm.encryptKeyHandleWithKey(key, wasm.exportKeyHandle(wrappingKey)),
			);
		},

		async unwrapKey(data, wrappingKey) {
			return wasm.decryptKeyHandleWithKey(
				sealed(data),
				wasm.exportKeyHandle(wrappingKey),
			);
		},

		// ------------------------------------------------------------------
		// RSA
		// ------------------------------------------------------------------

		async generateRsaKeyPair() {
			const pair = wasm.generateRSAKeyPair();
			return { publicKey: pair.public_key, privateKey: pair.private_key };
		},

		async rsaEncrypt(plaintext, publicKeyPem) {
			return wasm.rsaEncrypt(plaintext, publicKeyPem);
		},

		async rsaDecrypt(ciphertext, privateKeyPem) {
			return wasm.rsaDecrypt(ciphertext, privateKeyPem);
		},

		// ------------------------------------------------------------------
		// Vault keys and rotation
		// ------------------------------------------------------------------

		async encryptVaultKeyForMember(vaultKey, memberPublicKeyPem) {
			return wasm.encryptVaultKeyForMember(
				wasm.exportKeyHandle(vaultKey),
				memberPublicKeyPem,
			);
		},

		async encryptVaultKeyWithMuk(
			vaultKey,
			masterUnlockKey,
			vaultId,
			userId,
			keyVersion,
		) {
			return wasm.encryptVaultKeyWithMUK(
				wasm.exportKeyHandle(vaultKey),
				wasm.exportKeyHandle(masterUnlockKey),
				vaultId,
				userId,
				BigInt(keyVersion),
			);
		},

		async reEncryptItem(item, oldVaultKey, newVaultKey) {
			return reEncrypted(
				wasm.reEncryptItem(
					new wasm.JsItemData(
						item.id,
						item.encryptedData,
						item.encryptionIv,
						item.encryptionAlgorithm,
					),
					wasm.exportKeyHandle(oldVaultKey),
					wasm.exportKeyHandle(newVaultKey),
				),
			);
		},

		async performKeyRotation(
			oldVaultKey,
			members,
			items,
			vaultId,
			keyVersion,
			currentUserId,
			masterUnlockKey,
		) {
			const result = wasm.performKeyRotation(
				wasm.exportKeyHandle(oldVaultKey),
				membersJson(members),
				itemsJson(items),
				vaultId,
				BigInt(keyVersion),
				currentUserId,
				wasm.exportKeyHandle(masterUnlockKey),
			);

			const wrapped = result.getMemberEncryptedKeys() as Array<{
				user_id: string;
				encrypted_vault_key: string;
			}>;
			const rotated = result.getReEncryptedItems() as WasmReEncryptedItem[];

			return {
				memberEncryptedKeys: wrapped.map(
					(member): MemberEncryptedKey => ({
						userId: member.user_id,
						encryptedVaultKey: member.encrypted_vault_key,
					}),
				),
				reEncryptedItems: rotated.map(reEncrypted),
			};
		},

		async validateRotationData(members) {
			const result = wasm.validateRotationData(membersJson(members));
			return { valid: result.valid, errors: result.getErrors() as string[] };
		},

		// ------------------------------------------------------------------
		// Secret Key
		// ------------------------------------------------------------------

		async generateSecretKey() {
			return wasm.generateSecretKey();
		},

		async validateSecretKey(secretKey) {
			return wasm.validateSecretKey(secretKey);
		},

		// ------------------------------------------------------------------
		// Recovery
		// ------------------------------------------------------------------

		async generateRecoveryKey() {
			return wasm.generateRecoveryKey();
		},

		async validateRecoveryKey(recoveryKey) {
			return wasm.validateRecoveryKey(recoveryKey);
		},

		async encryptMasterKey(masterKey, recoveryKey, email) {
			return plain(
				wasm.encryptMasterKey(
					wasm.exportKeyHandle(masterKey),
					recoveryKey,
					email,
				),
			);
		},

		async decryptMasterKey(data, recoveryKey, email) {
			return wasm.importKeyHandle(
				wasm.decryptMasterKey(sealed(data), recoveryKey, email),
			);
		},

		// ------------------------------------------------------------------
		// SRP-6a client
		// ------------------------------------------------------------------

		async generateSrpRegistration(password) {
			const salt = srp.generateSalt();
			return {
				salt,
				verifier: srp.deriveVerifier(srp.deriveSafePrivateKey(salt, password)),
			};
		},

		async generateClientEphemeral() {
			const ephemeral = srp.generateEphemeral();
			return { publicKey: ephemeral.public, secret: ephemeral.secret };
		},

		async deriveClientSession(clientEphemeralSecret, challenge, password) {
			// The username is empty because the private key already binds the salt, which
			// is what `deriveSafePrivateKey` is for; every Bittery client has done this
			// since the first SRP release and the server's verifier depends on it.
			const session = srp.deriveSession(
				clientEphemeralSecret,
				challenge.serverPublicKey,
				challenge.salt,
				"",
				srp.deriveSafePrivateKey(challenge.salt, password),
			);
			sessions.set(session.proof, session);
			return { key: session.key, proof: session.proof };
		},

		async verifyServerSession(
			clientPublicEphemeral,
			session,
			serverSessionProof,
		) {
			const held = sessions.get(session.proof);
			if (held === undefined) {
				throw new BackendFailure(
					"invalid-input",
					"This session was not derived by this crypto port.",
				);
			}
			srp.verifySession(clientPublicEphemeral, held, serverSessionProof);
			sessions.delete(session.proof);
		},

		// ------------------------------------------------------------------
		// Passkey / WebAuthn
		// ------------------------------------------------------------------

		async generatePasskeyKeypair() {
			const keypair = wasm.generatePasskeyKeypair();
			return {
				privateKey: keypair.private_key,
				publicKeyCose: keypair.public_key_cose,
			};
		},

		async generatePasskeyCredentialId() {
			return wasm.generatePasskeyCredentialId();
		},

		async buildPasskeyAttestationObject(
			rpId,
			credentialIdBase64,
			cosePublicKeyBase64,
			signCount,
		) {
			const attestation = wasm.buildPasskeyAttestationObject(
				rpId,
				credentialIdBase64,
				cosePublicKeyBase64,
				signCount,
			);
			return {
				authenticatorData: fromBase64(attestation.authenticator_data),
				attestationObject: fromBase64(attestation.attestation_object),
			};
		},

		async signPasskeyAssertion(
			privateKeyBase64,
			rpId,
			clientDataHashBase64,
			signCount,
		) {
			const assertion = wasm.signPasskeyAssertion(
				privateKeyBase64,
				rpId,
				clientDataHashBase64,
				signCount,
			);
			return {
				authenticatorData: fromBase64(assertion.authenticator_data),
				signatureDer: fromBase64(assertion.signature_der),
			};
		},

		// ------------------------------------------------------------------
		// Identifiers
		// ------------------------------------------------------------------

		async generateUuid() {
			return wasm.generateUuid();
		},
	};
}

// ============================================================================
// Loading the backend
// ============================================================================

/**
 * Load the backend once, lazily, and keep it — except a failed load is not remembered, so
 * the very next call gets a fresh attempt rather than a port poisoned for its whole life.
 *
 * Both consumers need exactly this rule: the worker loads WASM once per thread, and the
 * extension's same-thread adapter loads it once per service-worker instance — an instance
 * that can itself be torn down and rebuilt at any time, at which point this function is
 * called again from scratch and gets its own fresh, unmemoised attempt.
 */
export function memoizedBackendLoader(
	loadWasm: LoadCryptoWasm,
): () => Promise<WasmWorkerBackend> {
	let backend: Promise<WasmWorkerBackend> | null = null;
	return () => {
		backend ??= loadWasm()
			.then(createCryptoWasmBackend)
			.catch((error: unknown) => {
				backend = null;
				throw error;
			});
		return backend;
	};
}

/**
 * The real binding. Returning the imported namespace as a `CryptoWasm` is what makes
 * `CryptoWasm` an assertion about `@bittery/crypto-wasm` rather than a wish.
 */
export const loadCryptoWasm: LoadCryptoWasm = async () => {
	const wasm = await import("@bittery/crypto-wasm");
	await wasm.default();
	return wasm;
};
