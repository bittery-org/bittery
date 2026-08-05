/**
 * The mobile adapter: a `CryptoPort` over `@bittery/crypto-nitro`, the Expo native module
 * that wraps `bittery-crypto-ffi` for iOS (Swift) and Android (Kotlin/JNI).
 *
 * Like Tauri, there is no backend key table behind this boundary — every native method takes
 * key material as a base64 argument and hands back base64 or a decoded value. So here too a
 * `KeyRef` is a boxed `Uint8Array`, minted through `createKeyRefTable`, whose bytes live on
 * the JS side and are marshalled into each native call as base64. `destroyKey` zeroizes that
 * array; nothing else can. The four lifetime rules the conformance suite pins (foreign ref
 * throws, destroyed ref throws, `destroyKey` zeroizes and is idempotent, `cloneKey` has its
 * own lifetime) are properties of `createKeyRefTable`, not of this file.
 *
 * ## Why this isn't a generic forward like `wasm.ts`
 *
 * `@bittery/crypto-nitro`'s TS surface (`BitteryCryptoModule.ts`) has one function per native
 * method, closer to `@bittery/crypto-wasm`'s shape than to Tauri's — but it is not uniform
 * enough for a `FORWARDED_MEMBERS` tuple: `encrypt`/`encryptWithContext` are two functions
 * where the port has one member with a nullable `context`, `decryptMany` has no batch
 * primitive at all, and `generateSrpRegistration`/`generateClientEphemeral`/
 * `deriveClientSession`/`verifyServerSession` are four port members over one stateful native
 * SRP client object (`createSRPClient`), not four independent calls. So — like `tauri.ts` —
 * this file implements `CryptoPort` directly as an object literal; totality is still
 * compiler-enforced because a member missing from that literal fails to typecheck against the
 * `CryptoPort` return type.
 *
 * ## The binding surface, and the two normalisations every member here makes
 *
 * `ExpoCryptoModule` below is the slice of `@bittery/crypto-nitro`'s exports this file calls,
 * declared structurally so a test can run the real marshalling over a double — and so the
 * compiler compares this declaration against the real module on every build: `defaultDeps`
 * returns the imported namespace with no cast, so a member this file expects but the module
 * lacks (or types differently) fails to compile, not just to run.
 *
 *   1. **Sync becomes async.** `generateUuid`, `validateRecoveryKey`, `generateRecoveryKey`,
 *      `generateSecretKey`, `validateSecretKey`, `generateEncryptionKey`,
 *      `generatePasskeyCredentialId` and every method on the SRP client object are plain
 *      sync functions on the module (Expo's `Function`, not `AsyncFunction`); `CryptoPort` is
 *      all-async. Every one of them is wrapped in `withPortErrors(async () => …)` here so a
 *      synchronous native throw still becomes a `CryptoPortError` rather than an uncaught
 *      exception.
 *   2. **Passkey attestation/assertion cross this module as base64 strings**
 *      (`buildPasskeyAttestationObject` / `signPasskeyAssertion`), but the port's
 *      `PasskeyAttestation` / `PasskeyAssertion` are `Uint8Array` — for direct use in a
 *      `PublicKeyCredential` response. The `fromBase64` conversion happens only in those two
 *      members, nowhere else.
 *
 * Everything else this module returns already matches the port's field names byte for byte
 * (`EncryptedData`, `RsaKeyPair`, `PasskeyKeypair`, `ReEncryptedItem`, `KeyRotationResult`,
 * `ValidationResult` all come back with the same shape `@bittery/types` already declares —
 * unlike Tauri's snake_case commands, there is no field-by-field remapping to do here).
 *
 * ## What has no dedicated native call
 *
 * `wrapKey`/`unwrapKey` reuse `encrypt`/`decrypt` over the key's own base64, exactly as
 * `tauri.ts` does: no Swift/Kotlin/JNI symbol named "wrap a key" exists, because
 * `bittery_encrypt_key_handle_with_key` (WASM's own primitive for this) is itself just
 * `encrypt(base64(key), wrappingKey)`. `deriveSrpPassword` needs no native call either — it is
 * `String::from_utf8_lossy(auth_key)` in Rust, exactly what `TextDecoder` does here.
 * `decryptMany` has no batch primitive on this module (unlike web's worker, there is no
 * round trip to amortise on a single JS thread anyway), so it loops over `decrypt`/
 * `decryptWithContext`, isolating a per-item failure exactly as `tauri.ts` does.
 */

import type {
	DerivedKeys,
	EncryptedData,
	EncryptionContext,
	ItemData,
	KdfProfile,
	KeyRotationResult,
	MemberKeyData,
	ReEncryptedItem,
	RsaKeyPair,
	SRPClientSession,
	ValidationResult,
} from "@bittery/types";
import type { CryptoPort, PasskeyKeypair } from "../crypto-port";
import { CryptoPortError, type CryptoPortErrorCode } from "../errors";
import { createKeyRefTable } from "../key-ref";

// ============================================================================
// The `@bittery/crypto-nitro` surface, as this adapter calls it
// ============================================================================

interface ExpoSrpEphemeral {
	public: string;
	secret: string;
}

/**
 * `createSRPClient`'s returned object. The native side holds one allocation per instance
 * (freed by `destroy()`, which this adapter deliberately never calls — see `loadSrp` below),
 * but every method here is a pure function of that instance's fixed hash algorithm and prime
 * group plus its own arguments; nothing about a prior call is remembered between them.
 */
interface ExpoSrpClient {
	generateSalt(): string;
	deriveSafePrivateKey(salt: string, password: string): Promise<string>;
	deriveVerifier(privateKey: string): string;
	generateEphemeral(): ExpoSrpEphemeral;
	deriveSession(
		clientSecretEphemeral: string,
		serverPublicEphemeral: string,
		salt: string,
		username: string,
		privateKey: string,
	): Promise<SRPClientSession>;
	verifySession(
		clientPublicEphemeral: string,
		session: SRPClientSession,
		serverSessionProof: string,
	): Promise<void>;
}

/** Base64 fields — matches the module's own `NativePasskeyAttestation`. */
interface ExpoPasskeyAttestation {
	authenticatorData: string;
	attestationObject: string;
}

/** Base64 fields — matches the module's own `NativePasskeyAssertion`. */
interface ExpoPasskeyAssertion {
	authenticatorData: string;
	signatureDer: string;
}

/**
 * The slice of `@bittery/crypto-nitro` this adapter calls, declared structurally so a test can
 * run the real marshalling over a double and so `defaultDeps.loadModule` (below) compares this
 * declaration against the real module's exports on every build — no cast, so a member this
 * file expects but the module doesn't have, or types differently, fails to compile.
 */
export interface ExpoCryptoModule {
	deriveKeys(
		password: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<DerivedKeys>;
	deriveMasterKey(
		accountPassword: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<string>;
	deriveKeysFromMasterKey(
		masterKeyBase64: string,
		email: string,
	): Promise<DerivedKeys>;

	encrypt(plaintext: string, keyBase64: string): Promise<EncryptedData>;
	encryptWithContext(
		plaintext: string,
		keyBase64: string,
		vaultId: string,
		entityId: string,
		entityType: string,
		version: number,
		userId: string,
	): Promise<EncryptedData>;
	decrypt(
		ciphertext: string,
		iv: string,
		algorithm: string,
		keyBase64: string,
	): Promise<string>;
	decryptWithContext(
		ciphertext: string,
		iv: string,
		algorithm: string,
		keyBase64: string,
		vaultId: string,
		entityId: string,
		entityType: string,
		version: number,
		userId: string,
	): Promise<string>;

	generateEncryptionKey(): string;
	generateUuid(): string;

	generateRsaKeyPair(): Promise<RsaKeyPair>;
	rsaEncrypt(plaintext: string, publicKeyPem: string): Promise<string>;
	rsaDecrypt(ciphertext: string, privateKeyPem: string): Promise<string>;

	generateSecretKey(): string;
	validateSecretKey(secretKey: string): boolean;
	generateRecoveryKey(): string;
	validateRecoveryKey(recoveryKey: string): boolean;
	encryptMasterKey(
		masterKeyBase64: string,
		recoveryKey: string,
		email: string,
	): Promise<EncryptedData>;
	decryptMasterKey(
		ciphertext: string,
		iv: string,
		algorithm: string,
		recoveryKey: string,
		email: string,
	): Promise<string>;

	createSRPClient(hashAlgorithm: "SHA-256", primeGroup: 4096): ExpoSrpClient;

	generatePasskeyKeypair(): Promise<PasskeyKeypair>;
	generatePasskeyCredentialId(): string;
	buildPasskeyAttestationObject(
		rpId: string,
		credentialIdBase64: string,
		cosePublicKeyBase64: string,
		signCount: number,
	): Promise<ExpoPasskeyAttestation>;
	signPasskeyAssertion(
		privateKeyBase64: string,
		rpId: string,
		clientDataHashBase64: string,
		signCount: number,
	): Promise<ExpoPasskeyAssertion>;

	encryptVaultKeyForMember(
		vaultKeyBase64: string,
		memberPublicKeyPem: string,
	): Promise<string>;
	encryptVaultKeyWithMuk(
		vaultKeyBase64: string,
		masterUnlockKeyBase64: string,
		vaultId: string,
		userId: string,
		keyVersion: number,
	): Promise<string>;
	reEncryptItem(
		item: ItemData,
		oldVaultKeyBase64: string,
		newVaultKeyBase64: string,
	): Promise<ReEncryptedItem>;
	performKeyRotation(
		oldVaultKeyBase64: string,
		members: MemberKeyData[],
		items: ItemData[],
		vaultId: string,
		keyVersion: number,
		currentUserId: string,
		masterUnlockKeyBase64: string,
	): Promise<KeyRotationResult>;
	validateRotationData(members: MemberKeyData[]): Promise<ValidationResult>;
}

/**
 * How `@bittery/crypto-nitro` is obtained. An optional peer dependency — `requireNativeModule`
 * runs at the module's own top-level scope, so importing it eagerly would throw the moment
 * this file loads on a platform without the native module linked. A dynamic `import()` defers
 * that to first use, exactly as `tauri.ts` defers `@tauri-apps/api/core`.
 */
export interface ExpoDeps {
	loadModule(): Promise<ExpoCryptoModule>;
}

const defaultDeps: ExpoDeps = {
	loadModule: async () => {
		const module = await import("@bittery/crypto-nitro");
		return module;
	},
};

/** One load per port instance, shared by every call. A rejection is cached too. */
function memoise<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | null = null;
	return () => {
		pending ??= load();
		return pending;
	};
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
// Error translation
// ============================================================================

/**
 * Malformed argument, in the vocabulary of `CryptoError`'s `Display` (`e.to_string()`, e.g.
 * "Invalid PEM format: …", "Base64 decode error: …") plus the FFI's own pre-decode guards
 * ("Invalid key base64: …", "Invalid members JSON: …") — the same strings `tauri.ts`'s
 * `classify` reads, because both adapters sit on the same `bittery-crypto-ffi` crate.
 */
const INVALID_INPUT_MARKERS = [
	"invalid pem",
	"base64",
	"invalid key length",
	"invalid iv length",
	"invalid secret key format",
	"utf-8 decode",
	"invalid input",
	"invalid members json",
	"invalid items json",
] as const;

function messageOf(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message;
	}
	return typeof cause === "string" ? cause : String(cause);
}

function classify(error: unknown): {
	code: CryptoPortErrorCode;
	message: string;
} {
	const message = messageOf(error);
	const text = message.toLowerCase();

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
	// The native module missing, a promise the bridge never resolved, a panic: the backend
	// rather than the call.
	return { code: "backend-failure", message };
}

async function withPortErrors<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		const { code, message } = classify(error);
		throw new CryptoPortError(code, message, { cause: error });
	}
}

// ============================================================================
// Symmetric encryption, shared by encrypt/decrypt and decryptMany
// ============================================================================

function encryptOnce(
	mod: ExpoCryptoModule,
	plaintext: string,
	keyBase64: string,
	context: EncryptionContext | null,
): Promise<EncryptedData> {
	return context === null
		? mod.encrypt(plaintext, keyBase64)
		: mod.encryptWithContext(
				plaintext,
				keyBase64,
				context.vaultId,
				context.entityId,
				context.entityType,
				context.version,
				context.userId,
			);
}

function decryptOnce(
	mod: ExpoCryptoModule,
	data: EncryptedData,
	keyBase64: string,
	context: EncryptionContext | null,
): Promise<string> {
	return context === null
		? mod.decrypt(data.ciphertext, data.iv, data.algorithm, keyBase64)
		: mod.decryptWithContext(
				data.ciphertext,
				data.iv,
				data.algorithm,
				keyBase64,
				context.vaultId,
				context.entityId,
				context.entityType,
				context.version,
				context.userId,
			);
}

// ============================================================================
// The adapter
// ============================================================================

export function createExpoCryptoPort(deps: ExpoDeps = defaultDeps): CryptoPort {
	const keys = createKeyRefTable<Uint8Array>();
	const loadModule = memoise(() => deps.loadModule());
	// A `deps.loadModule()` failure (the native module not linked, in production) is exactly
	// as much a backend failure as a native call rejecting, so it goes through the same
	// translation — every member calls `ensureModule` from inside `withPortErrors`, never
	// `loadModule` directly, or a load failure would reach the caller as a raw `Error`.
	const ensureModule = () => withPortErrors(loadModule);

	// One SRP client for the life of this port instance, never freed — the same choice the
	// wasm adapters make for their own `JsSrpClient` (never call `.free()`). Each `SrpClient`
	// allocation on the native side is one entry in a dictionary keyed by an incrementing ID;
	// creating one per port instance rather than per call is a single, bounded, one-time cost.
	const loadSrp = memoise(async () => {
		const mod = await ensureModule();
		return mod.createSRPClient("SHA-256", 4096);
	});
	const ensureSrp = () => withPortErrors(loadSrp);

	const port: CryptoPort = {
		initialize: async () => {
			await ensureModule();
		},

		// ------------------------------------------------------------------
		// Key lifecycle
		// ------------------------------------------------------------------

		generateEncryptionKey: async () => {
			const mod = await ensureModule();
			const base64 = await withPortErrors(async () =>
				mod.generateEncryptionKey(),
			);
			return keys.create(fromBase64(base64));
		},

		importKey: async (key) => keys.create(key.slice()),

		exportKey: async (key) => keys.read(key).slice(),

		cloneKey: async (key) => keys.create(keys.read(key).slice()),

		destroyKey: async (key) => {
			keys.dispose(key)?.fill(0);
		},

		// ------------------------------------------------------------------
		// Derivation
		// ------------------------------------------------------------------

		deriveKeys: async (accountPassword, secretKey, email, profile) => {
			const mod = await ensureModule();
			const derived = await withPortErrors(() =>
				mod.deriveKeys(accountPassword, secretKey, email, profile),
			);
			return {
				authKey: keys.create(derived.authKey),
				masterUnlockKey: keys.create(derived.masterUnlockKey),
			};
		},

		deriveMasterKey: async (accountPassword, secretKey, email, profile) => {
			const mod = await ensureModule();
			const base64 = await withPortErrors(() =>
				mod.deriveMasterKey(accountPassword, secretKey, email, profile),
			);
			return keys.create(fromBase64(base64));
		},

		deriveKeysFromMasterKey: async (masterKey, email) => {
			const masterKeyBase64 = toBase64(keys.read(masterKey));
			const mod = await ensureModule();
			const derived = await withPortErrors(() =>
				mod.deriveKeysFromMasterKey(masterKeyBase64, email),
			);
			return {
				authKey: keys.create(derived.authKey),
				masterUnlockKey: keys.create(derived.masterUnlockKey),
			};
		},

		// No native call exists for this because none is needed: it is
		// `String::from_utf8_lossy(auth_key)` in Rust, which is exactly what `TextDecoder`
		// does, so it never crosses the bridge.
		deriveSrpPassword: async (authKey) =>
			new TextDecoder().decode(keys.read(authKey)),

		// ------------------------------------------------------------------
		// Symmetric encryption
		// ------------------------------------------------------------------

		encrypt: async (plaintext, key, context) => {
			const keyBase64 = toBase64(keys.read(key));
			const mod = await ensureModule();
			return withPortErrors(() =>
				encryptOnce(mod, plaintext, keyBase64, context),
			);
		},

		decrypt: async (data, key, context) => {
			const keyBase64 = toBase64(keys.read(key));
			const mod = await ensureModule();
			return withPortErrors(() => decryptOnce(mod, data, keyBase64, context));
		},

		decryptMany: async (requests) => {
			// Every ref is resolved before any native call, so a foreign or destroyed KeyRef
			// fails the whole batch rather than just its own item — matching every other
			// adapter's `decryptMany`.
			const resolved = requests.map((request) => ({
				id: request.id,
				data: request.data,
				context: request.context,
				keyBase64: toBase64(keys.read(request.key)),
			}));
			const mod = await ensureModule();
			return Promise.all(
				resolved.map(async (request) => {
					try {
						const plaintext = await withPortErrors(() =>
							decryptOnce(
								mod,
								request.data,
								request.keyBase64,
								request.context,
							),
						);
						return { id: request.id, ok: true as const, plaintext };
					} catch (error) {
						const message =
							error instanceof CryptoPortError ? error.message : String(error);
						return { id: request.id, ok: false as const, error: message };
					}
				}),
			);
		},

		// No native "wrap a key" primitive exists on this module, exactly as none exists in
		// the Tauri command surface — `encrypt`/`decrypt` over the key's own base64 already
		// is that operation (see `tauri.ts`'s note on `bittery_encrypt_key_handle_with_key`).
		wrapKey: async (key, wrappingKey) => {
			const payloadBase64 = toBase64(keys.read(key));
			const wrappingKeyBase64 = toBase64(keys.read(wrappingKey));
			const mod = await ensureModule();
			return withPortErrors(() =>
				mod.encrypt(payloadBase64, wrappingKeyBase64),
			);
		},

		unwrapKey: async (data, wrappingKey) => {
			const wrappingKeyBase64 = toBase64(keys.read(wrappingKey));
			const mod = await ensureModule();
			const plaintextBase64 = await withPortErrors(() =>
				mod.decrypt(
					data.ciphertext,
					data.iv,
					data.algorithm,
					wrappingKeyBase64,
				),
			);
			return keys.create(fromBase64(plaintextBase64));
		},

		// ------------------------------------------------------------------
		// RSA
		// ------------------------------------------------------------------

		generateRsaKeyPair: async () => {
			const mod = await ensureModule();
			return withPortErrors(() => mod.generateRsaKeyPair());
		},

		rsaEncrypt: async (plaintext, publicKeyPem) => {
			const mod = await ensureModule();
			return withPortErrors(() => mod.rsaEncrypt(plaintext, publicKeyPem));
		},

		rsaDecrypt: async (ciphertext, privateKeyPem) => {
			const mod = await ensureModule();
			return withPortErrors(() => mod.rsaDecrypt(ciphertext, privateKeyPem));
		},

		// ------------------------------------------------------------------
		// Vault keys and rotation
		// ------------------------------------------------------------------

		encryptVaultKeyForMember: async (vaultKey, memberPublicKeyPem) => {
			const vaultKeyBase64 = toBase64(keys.read(vaultKey));
			const mod = await ensureModule();
			return withPortErrors(() =>
				mod.encryptVaultKeyForMember(vaultKeyBase64, memberPublicKeyPem),
			);
		},

		encryptVaultKeyWithMuk: async (
			vaultKey,
			masterUnlockKey,
			vaultId,
			userId,
			keyVersion,
		) => {
			const vaultKeyBase64 = toBase64(keys.read(vaultKey));
			const masterUnlockKeyBase64 = toBase64(keys.read(masterUnlockKey));
			const mod = await ensureModule();
			return withPortErrors(() =>
				mod.encryptVaultKeyWithMuk(
					vaultKeyBase64,
					masterUnlockKeyBase64,
					vaultId,
					userId,
					keyVersion,
				),
			);
		},

		reEncryptItem: async (item, oldVaultKey, newVaultKey) => {
			const oldVaultKeyBase64 = toBase64(keys.read(oldVaultKey));
			const newVaultKeyBase64 = toBase64(keys.read(newVaultKey));
			const mod = await ensureModule();
			return withPortErrors(() =>
				mod.reEncryptItem(item, oldVaultKeyBase64, newVaultKeyBase64),
			);
		},

		performKeyRotation: async (
			oldVaultKey,
			members,
			items,
			vaultId,
			keyVersion,
			currentUserId,
			masterUnlockKey,
		) => {
			const oldVaultKeyBase64 = toBase64(keys.read(oldVaultKey));
			const masterUnlockKeyBase64 = toBase64(keys.read(masterUnlockKey));
			const mod = await ensureModule();
			return withPortErrors(() =>
				mod.performKeyRotation(
					oldVaultKeyBase64,
					[...members],
					[...items],
					vaultId,
					keyVersion,
					currentUserId,
					masterUnlockKeyBase64,
				),
			);
		},

		validateRotationData: async (members) => {
			const mod = await ensureModule();
			return withPortErrors(() => mod.validateRotationData([...members]));
		},

		// ------------------------------------------------------------------
		// Secret Key
		// ------------------------------------------------------------------

		generateSecretKey: async () => {
			const mod = await ensureModule();
			return withPortErrors(async () => mod.generateSecretKey());
		},

		validateSecretKey: async (secretKey) => {
			const mod = await ensureModule();
			return withPortErrors(async () => mod.validateSecretKey(secretKey));
		},

		// ------------------------------------------------------------------
		// Recovery
		// ------------------------------------------------------------------

		generateRecoveryKey: async () => {
			const mod = await ensureModule();
			return withPortErrors(async () => mod.generateRecoveryKey());
		},

		validateRecoveryKey: async (recoveryKey) => {
			const mod = await ensureModule();
			return withPortErrors(async () => mod.validateRecoveryKey(recoveryKey));
		},

		encryptMasterKey: async (masterKey, recoveryKey, email) => {
			const masterKeyBase64 = toBase64(keys.read(masterKey));
			const mod = await ensureModule();
			return withPortErrors(() =>
				mod.encryptMasterKey(masterKeyBase64, recoveryKey, email),
			);
		},

		decryptMasterKey: async (data, recoveryKey, email) => {
			const mod = await ensureModule();
			const masterKeyBase64 = await withPortErrors(() =>
				mod.decryptMasterKey(
					data.ciphertext,
					data.iv,
					data.algorithm,
					recoveryKey,
					email,
				),
			);
			return keys.create(fromBase64(masterKeyBase64));
		},

		// ------------------------------------------------------------------
		// SRP-6a client
		// ------------------------------------------------------------------

		generateSrpRegistration: async (password) => {
			const srp = await ensureSrp();
			const salt = await withPortErrors(async () => srp.generateSalt());
			const privateKey = await withPortErrors(() =>
				srp.deriveSafePrivateKey(salt, password),
			);
			const verifier = await withPortErrors(async () =>
				srp.deriveVerifier(privateKey),
			);
			return { salt, verifier };
		},

		generateClientEphemeral: async () => {
			const srp = await ensureSrp();
			const ephemeral = await withPortErrors(async () =>
				srp.generateEphemeral(),
			);
			return { publicKey: ephemeral.public, secret: ephemeral.secret };
		},

		deriveClientSession: async (clientEphemeralSecret, challenge, password) => {
			const srp = await ensureSrp();
			// The username is empty because the private key already binds the salt — the
			// same choice every other adapter makes, and `challenge.kdfParams` is unused for
			// the same reason S5 recorded there: passing it into the private-key derivation
			// would change the verifier and break server interop, so it stays a decision for
			// whoever owns SRP, not this adapter.
			const privateKey = await withPortErrors(() =>
				srp.deriveSafePrivateKey(challenge.salt, password),
			);
			const session = await withPortErrors(() =>
				srp.deriveSession(
					clientEphemeralSecret,
					challenge.serverPublicKey,
					challenge.salt,
					"",
					privateKey,
				),
			);
			return { key: session.key, proof: session.proof };
		},

		verifyServerSession: async (
			clientPublicEphemeral,
			session,
			serverSessionProof,
		) => {
			const srp = await ensureSrp();
			await withPortErrors(() =>
				srp.verifySession(clientPublicEphemeral, session, serverSessionProof),
			);
		},

		// ------------------------------------------------------------------
		// Passkey / WebAuthn
		// ------------------------------------------------------------------

		generatePasskeyKeypair: async () => {
			const mod = await ensureModule();
			return withPortErrors(() => mod.generatePasskeyKeypair());
		},

		generatePasskeyCredentialId: async () => {
			const mod = await ensureModule();
			return withPortErrors(async () => mod.generatePasskeyCredentialId());
		},

		buildPasskeyAttestationObject: async (
			rpId,
			credentialIdBase64,
			cosePublicKeyBase64,
			signCount,
		) => {
			const mod = await ensureModule();
			const response = await withPortErrors(() =>
				mod.buildPasskeyAttestationObject(
					rpId,
					credentialIdBase64,
					cosePublicKeyBase64,
					signCount,
				),
			);
			return {
				authenticatorData: fromBase64(response.authenticatorData),
				attestationObject: fromBase64(response.attestationObject),
			};
		},

		signPasskeyAssertion: async (
			privateKeyBase64,
			rpId,
			clientDataHashBase64,
			signCount,
		) => {
			const mod = await ensureModule();
			const response = await withPortErrors(() =>
				mod.signPasskeyAssertion(
					privateKeyBase64,
					rpId,
					clientDataHashBase64,
					signCount,
				),
			);
			return {
				authenticatorData: fromBase64(response.authenticatorData),
				signatureDer: fromBase64(response.signatureDer),
			};
		},

		// ------------------------------------------------------------------
		// Identifiers
		// ------------------------------------------------------------------

		generateUuid: async () => {
			const mod = await ensureModule();
			return withPortErrors(async () => mod.generateUuid());
		},
	};

	return port;
}
