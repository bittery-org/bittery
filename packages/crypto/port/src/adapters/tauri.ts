/**
 * The desktop adapter: a `CryptoPort` over Tauri IPC (`invoke("crypto_*")`).
 *
 * There is no backend key table behind this IPC boundary the way there is behind WASM's —
 * `apps/desktop/src-tauri/src/crypto_commands.rs` is stateless, thin wrappers that take key
 * material as a base64 argument and hand back base64 or a `Result<T, String>`. So here a
 * `KeyRef` is exactly what the design calls for when nothing below the seam can hold it: a
 * boxed `Uint8Array`, minted through `createKeyRefTable`, whose bytes live on the JS side and
 * are marshalled into each `invoke` call as base64. `destroyKey` zeroizes that array; nothing
 * else can. The four lifetime rules the conformance suite pins (foreign ref throws, destroyed
 * ref throws, `destroyKey` zeroizes and is idempotent, `cloneKey` has its own lifetime) are
 * therefore properties of `createKeyRefTable` here exactly as they are in every other adapter
 * — this file never re-derives them.
 *
 * ## Why this isn't a generic forward like `wasm.ts`
 *
 * The wasm adapters can build `FORWARDED_MEMBERS` because `@bittery/crypto-wasm` exposes one
 * binding function per port member with a matching argument order — swap `KeyRef` for a
 * handle and the two shapes line up. Tauri's command surface does not: `deriveKeys` is one
 * command, `wrapKey`/`unwrapKey` have no command of their own (they reuse `crypto_encrypt` /
 * `crypto_decrypt` over the key's own base64, exactly as `bittery_encrypt_key_handle_with_key`
 * does in Rust — read `packages/crypto/core/crates/bittery-crypto-wasm/src/lib.rs` to see it's
 * the same operation, not a shortcut), and `generateSrpRegistration` is three chained
 * commands. So this file implements `CryptoPort` directly as an object literal; the compiler
 * still enforces totality, because a member missing from that literal fails to typecheck
 * against the `CryptoPort` return type — no `FORWARDED_MEMBERS` tuple is needed to get that.
 *
 * ## What has no command at all
 *
 * `deriveSrpPassword` needs none: it is `String::from_utf8_lossy(auth_key)` in Rust, which is
 * exactly what `TextDecoder` does here, so it never crosses IPC. Every other member is backed
 * by a real `crypto_*` command, registered in `apps/desktop/src-tauri/src/lib.rs`'s
 * `generate_handler!` list — checked one by one against that file and against
 * `crypto_commands.rs`'s argument names while writing `TauriInvoke` below.
 */

import type {
	EncryptedData,
	EncryptionContext,
	ItemData,
	MemberKeyData,
} from "@bittery/types";
import type { CryptoPort } from "../crypto-port";
import { CryptoPortError, type CryptoPortErrorCode } from "../errors";
import { createKeyRefTable } from "../key-ref";

// ============================================================================
// The Tauri commands, as this adapter calls them
// ============================================================================

interface DerivedKeysResponse {
	auth_key: string;
	master_unlock_key: string;
}

interface EncryptResponse {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

interface RsaKeyPairResponse {
	public_key: string;
	private_key: string;
}

interface EphemeralResponse {
	public: string;
	secret: string;
}

interface SessionResponse {
	key: string;
	proof: string;
}

interface PasskeyKeypairResponse {
	private_key: string;
	public_key_cose: string;
}

interface PasskeyAttestationResponse {
	authenticator_data: string;
	attestation_object: string;
}

interface PasskeyAssertionResponse {
	authenticator_data: string;
	signature_der: string;
}

interface ReEncryptedItemResponse {
	item_id: string;
	encrypted_data: string;
	encryption_iv: string;
}

interface MemberEncryptedKeyResponse {
	user_id: string;
	encrypted_vault_key: string;
}

interface KeyRotationResponse {
	member_encrypted_keys: MemberEncryptedKeyResponse[];
	re_encrypted_items: ReEncryptedItemResponse[];
}

interface ValidationResponse {
	valid: boolean;
	errors: string[];
}

interface TauriItemData {
	id: string;
	encrypted_data: string;
	encryption_iv: string;
	encryption_algorithm: string;
}

interface TauriMemberKeyData {
	user_id: string;
	public_key: string;
}

/**
 * The `crypto_*` commands this adapter calls, one overload per command, argument names
 * exactly as `apps/desktop/src-tauri/src/crypto_commands.rs` declares its Rust parameters
 * (Tauri maps a JS camelCase argument key to the same-named snake_case Rust parameter; a
 * struct's own fields are plain serde and get no such conversion, which is why `item`,
 * `members` and `members[].public_key` below are hand-written snake_case). Every command
 * named here is confirmed present in `lib.rs`'s `tauri::generate_handler!` list.
 *
 * Two commands the desktop app already has are deliberately absent: `crypto_get_secret_key_hint`
 * and `crypto_validate_kdf_profile` are policy the port does not carry (S4's design; hint
 * derivation and KDF pinning live above the seam).
 */
export interface TauriInvoke {
	(
		cmd: "crypto_derive_keys",
		args: {
			password: string;
			secretKey: string;
			email: string;
			schemaVersion: number;
			algorithm: string;
			iterations: number;
		},
	): Promise<DerivedKeysResponse>;
	(
		cmd: "crypto_derive_master_key",
		args: {
			accountPassword: string;
			secretKey: string;
			email: string;
			schemaVersion: number;
			algorithm: string;
			iterations: number;
		},
	): Promise<string>;
	(
		cmd: "crypto_derive_keys_from_master_key",
		args: { masterKeyBase64: string; email: string },
	): Promise<DerivedKeysResponse>;
	(
		cmd: "crypto_encrypt",
		args: { plaintext: string; keyBase64: string },
	): Promise<EncryptResponse>;
	(
		cmd: "crypto_encrypt_with_context",
		args: {
			plaintext: string;
			keyBase64: string;
			vaultId: string;
			entityId: string;
			entityType: string;
			version: number;
			userId: string;
		},
	): Promise<EncryptResponse>;
	(
		cmd: "crypto_decrypt",
		args: {
			ciphertext: string;
			iv: string;
			algorithm: string;
			keyBase64: string;
		},
	): Promise<string>;
	(
		cmd: "crypto_decrypt_with_context",
		args: {
			ciphertext: string;
			iv: string;
			algorithm: string;
			keyBase64: string;
			vaultId: string;
			entityId: string;
			entityType: string;
			version: number;
			userId: string;
		},
	): Promise<string>;
	(cmd: "crypto_generate_encryption_key"): Promise<string>;
	(cmd: "crypto_generate_uuid"): Promise<string>;
	(cmd: "crypto_generate_rsa_key_pair"): Promise<RsaKeyPairResponse>;
	(
		cmd: "crypto_rsa_encrypt",
		args: { plaintext: string; publicKeyPem: string },
	): Promise<string>;
	(
		cmd: "crypto_rsa_decrypt",
		args: { ciphertext: string; privateKeyPem: string },
	): Promise<string>;
	(cmd: "crypto_generate_secret_key"): Promise<string>;
	(
		cmd: "crypto_validate_secret_key",
		args: { secretKey: string },
	): Promise<boolean>;
	(cmd: "crypto_generate_recovery_key"): Promise<string>;
	(
		cmd: "crypto_validate_recovery_key",
		args: { recoveryKey: string },
	): Promise<boolean>;
	(
		cmd: "crypto_encrypt_master_key",
		args: { masterKeyBase64: string; recoveryKey: string; email: string },
	): Promise<EncryptResponse>;
	(
		cmd: "crypto_decrypt_master_key",
		args: {
			ciphertext: string;
			iv: string;
			algorithm: string;
			recoveryKey: string;
			email: string;
		},
	): Promise<string>;
	(cmd: "crypto_srp_generate_salt"): Promise<string>;
	(
		cmd: "crypto_srp_derive_safe_private_key",
		args: { salt: string; password: string; iterations: number | null },
	): Promise<string>;
	(
		cmd: "crypto_srp_derive_verifier",
		args: { privateKey: string },
	): Promise<string>;
	(cmd: "crypto_srp_generate_ephemeral"): Promise<EphemeralResponse>;
	(
		cmd: "crypto_srp_derive_session",
		args: {
			clientSecretEphemeral: string;
			serverPublicEphemeral: string;
			salt: string;
			username: string;
			privateKey: string;
		},
	): Promise<SessionResponse>;
	(
		cmd: "crypto_srp_verify_session",
		args: {
			clientPublicEphemeral: string;
			sessionKey: string;
			sessionProof: string;
			serverSessionProof: string;
		},
	): Promise<void>;
	(cmd: "crypto_passkey_generate_keypair"): Promise<PasskeyKeypairResponse>;
	(cmd: "crypto_passkey_generate_credential_id"): Promise<string>;
	(
		cmd: "crypto_passkey_build_attestation_object",
		args: {
			rpId: string;
			credentialIdBase64: string;
			cosePublicKeyBase64: string;
			signCount: number;
		},
	): Promise<PasskeyAttestationResponse>;
	(
		cmd: "crypto_passkey_sign_assertion",
		args: {
			privateKeyBase64: string;
			rpId: string;
			clientDataHashBase64: string;
			signCount: number;
		},
	): Promise<PasskeyAssertionResponse>;
	(
		cmd: "crypto_encrypt_vault_key_for_member",
		args: { vaultKeyBase64: string; memberPublicKey: string },
	): Promise<string>;
	(
		cmd: "crypto_encrypt_vault_key_with_muk",
		args: {
			vaultKeyBase64: string;
			masterUnlockKeyBase64: string;
			vaultId: string;
			userId: string;
			keyVersion: number;
		},
	): Promise<string>;
	(
		cmd: "crypto_re_encrypt_item",
		args: {
			item: TauriItemData;
			oldVaultKeyBase64: string;
			newVaultKeyBase64: string;
		},
	): Promise<ReEncryptedItemResponse>;
	(
		cmd: "crypto_perform_key_rotation",
		args: {
			oldVaultKeyBase64: string;
			members: TauriMemberKeyData[];
			items: TauriItemData[];
			vaultId: string;
			keyVersion: number;
			currentUserId: string;
			masterUnlockKeyBase64: string;
		},
	): Promise<KeyRotationResponse>;
	(
		cmd: "crypto_validate_rotation_data",
		args: { members: TauriMemberKeyData[] },
	): Promise<ValidationResponse>;
}

/**
 * How `@tauri-apps/api/core` is obtained. An optional peer dependency, so it stays behind a
 * dynamic `import()` the way every other Tauri module does in this repo (see
 * `packages/storage/src/adapters/tauri.ts`); `tauri-test-doubles.ts` hands over a double
 * instead, because a test process has no Tauri IPC to answer it.
 */
export interface TauriDeps {
	loadInvoke(): Promise<TauriInvoke>;
}

const defaultDeps: TauriDeps = {
	loadInvoke: async () => {
		const module = await import("@tauri-apps/api/core");
		return module.invoke as TauriInvoke;
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
 * "Invalid PEM format: …", "Base64 decode error: …") plus `crypto_commands.rs`'s own
 * pre-decode guard (`format!("Invalid {x} base64: {}", e)` for every base64 argument this
 * file sends — "base64" alone catches all of them without enumerating each one).
 */
const INVALID_INPUT_MARKERS = [
	"invalid pem",
	"base64",
	"invalid key length",
	"invalid iv length",
	"invalid secret key format",
	"utf-8 decode",
	"invalid input",
] as const;

/** A `Result<T, String>` command rejects with the plain string, not an `Error`. */
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
	// IPC lost, a command panicked, a Tauri-level deserialization failure: the backend
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
	invoke: TauriInvoke,
	plaintext: string,
	keyBase64: string,
	context: EncryptionContext | null,
): Promise<EncryptResponse> {
	return context === null
		? invoke("crypto_encrypt", { plaintext, keyBase64 })
		: invoke("crypto_encrypt_with_context", {
				plaintext,
				keyBase64,
				vaultId: context.vaultId,
				entityId: context.entityId,
				entityType: context.entityType,
				version: context.version,
				userId: context.userId,
			});
}

function decryptOnce(
	invoke: TauriInvoke,
	data: EncryptedData,
	keyBase64: string,
	context: EncryptionContext | null,
): Promise<string> {
	return context === null
		? invoke("crypto_decrypt", {
				ciphertext: data.ciphertext,
				iv: data.iv,
				algorithm: data.algorithm,
				keyBase64,
			})
		: invoke("crypto_decrypt_with_context", {
				ciphertext: data.ciphertext,
				iv: data.iv,
				algorithm: data.algorithm,
				keyBase64,
				vaultId: context.vaultId,
				entityId: context.entityId,
				entityType: context.entityType,
				version: context.version,
				userId: context.userId,
			});
}

function toTauriItem(item: ItemData): TauriItemData {
	return {
		id: item.id,
		encrypted_data: item.encryptedData,
		encryption_iv: item.encryptionIv,
		encryption_algorithm: item.encryptionAlgorithm,
	};
}

function toTauriMember(member: MemberKeyData): TauriMemberKeyData {
	return { user_id: member.userId, public_key: member.publicKey };
}

// ============================================================================
// The adapter
// ============================================================================

export function createTauriCryptoPort(
	deps: TauriDeps = defaultDeps,
): CryptoPort {
	const keys = createKeyRefTable<Uint8Array>();
	const loadInvoke = memoise(() => deps.loadInvoke());
	// `deps.loadInvoke` failing (the module missing, in production) is exactly as much a
	// backend failure as a command rejecting, so it goes through the same translation —
	// every member calls `ensureInvoke` from inside `withPortErrors`, never `loadInvoke`
	// directly, or a load failure would reach the caller as a raw `Error`.
	const ensureInvoke = () => withPortErrors(loadInvoke);

	const port: CryptoPort = {
		initialize: async () => {
			await ensureInvoke();
		},

		// ------------------------------------------------------------------
		// Key lifecycle
		// ------------------------------------------------------------------

		generateEncryptionKey: async () => {
			const invoke = await ensureInvoke();
			const base64 = await withPortErrors(() =>
				invoke("crypto_generate_encryption_key"),
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
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_derive_keys", {
					password: accountPassword,
					secretKey,
					email,
					schemaVersion: profile.schemaVersion,
					algorithm: profile.algorithm,
					iterations: profile.iterations,
				}),
			);
			return {
				authKey: keys.create(fromBase64(response.auth_key)),
				masterUnlockKey: keys.create(fromBase64(response.master_unlock_key)),
			};
		},

		deriveMasterKey: async (accountPassword, secretKey, email, profile) => {
			const invoke = await ensureInvoke();
			const base64 = await withPortErrors(() =>
				invoke("crypto_derive_master_key", {
					accountPassword,
					secretKey,
					email,
					schemaVersion: profile.schemaVersion,
					algorithm: profile.algorithm,
					iterations: profile.iterations,
				}),
			);
			return keys.create(fromBase64(base64));
		},

		deriveKeysFromMasterKey: async (masterKey, email) => {
			const masterKeyBase64 = toBase64(keys.read(masterKey));
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_derive_keys_from_master_key", {
					masterKeyBase64,
					email,
				}),
			);
			return {
				authKey: keys.create(fromBase64(response.auth_key)),
				masterUnlockKey: keys.create(fromBase64(response.master_unlock_key)),
			};
		},

		// No command exists for this because none is needed: it is
		// `String::from_utf8_lossy(auth_key)` in Rust, which is exactly what `TextDecoder`
		// does, so it never crosses IPC.
		deriveSrpPassword: async (authKey) =>
			new TextDecoder().decode(keys.read(authKey)),

		// ------------------------------------------------------------------
		// Symmetric encryption
		// ------------------------------------------------------------------

		encrypt: async (plaintext, key, context) => {
			const keyBase64 = toBase64(keys.read(key));
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				encryptOnce(invoke, plaintext, keyBase64, context),
			);
		},

		decrypt: async (data, key, context) => {
			const keyBase64 = toBase64(keys.read(key));
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				decryptOnce(invoke, data, keyBase64, context),
			);
		},

		decryptMany: async (requests) => {
			// Every ref is resolved before any IPC call, so a foreign or destroyed KeyRef
			// fails the whole batch rather than just its own item — matching the wasm
			// adapters, whose generic dispatch resolves every KeyRef in the call before the
			// backend is touched.
			const resolved = requests.map((request) => ({
				id: request.id,
				data: request.data,
				context: request.context,
				keyBase64: toBase64(keys.read(request.key)),
			}));
			const invoke = await ensureInvoke();
			return Promise.all(
				resolved.map(async (request) => {
					try {
						const plaintext = await withPortErrors(() =>
							decryptOnce(
								invoke,
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

		// `bittery_encrypt_key_handle_with_key` in Rust is exactly `encrypt(base64(key),
		// wrappingKey)` (see `bittery-crypto-wasm/src/lib.rs`) — there is no separate
		// "wrap a key" primitive to call, so this reuses `crypto_encrypt`/`crypto_decrypt`
		// over the key's own base64 rather than composing other port members.
		wrapKey: async (key, wrappingKey) => {
			const payloadBase64 = toBase64(keys.read(key));
			const wrappingKeyBase64 = toBase64(keys.read(wrappingKey));
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_encrypt", {
					plaintext: payloadBase64,
					keyBase64: wrappingKeyBase64,
				}),
			);
		},

		unwrapKey: async (data, wrappingKey) => {
			const wrappingKeyBase64 = toBase64(keys.read(wrappingKey));
			const invoke = await ensureInvoke();
			const plaintextBase64 = await withPortErrors(() =>
				invoke("crypto_decrypt", {
					ciphertext: data.ciphertext,
					iv: data.iv,
					algorithm: data.algorithm,
					keyBase64: wrappingKeyBase64,
				}),
			);
			return keys.create(fromBase64(plaintextBase64));
		},

		// ------------------------------------------------------------------
		// RSA
		// ------------------------------------------------------------------

		generateRsaKeyPair: async () => {
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_generate_rsa_key_pair"),
			);
			return {
				publicKey: response.public_key,
				privateKey: response.private_key,
			};
		},

		rsaEncrypt: async (plaintext, publicKeyPem) => {
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_rsa_encrypt", { plaintext, publicKeyPem }),
			);
		},

		rsaDecrypt: async (ciphertext, privateKeyPem) => {
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_rsa_decrypt", { ciphertext, privateKeyPem }),
			);
		},

		// ------------------------------------------------------------------
		// Vault keys and rotation
		// ------------------------------------------------------------------

		encryptVaultKeyForMember: async (vaultKey, memberPublicKeyPem) => {
			const vaultKeyBase64 = toBase64(keys.read(vaultKey));
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_encrypt_vault_key_for_member", {
					vaultKeyBase64,
					memberPublicKey: memberPublicKeyPem,
				}),
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
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_encrypt_vault_key_with_muk", {
					vaultKeyBase64,
					masterUnlockKeyBase64,
					vaultId,
					userId,
					keyVersion,
				}),
			);
		},

		reEncryptItem: async (item, oldVaultKey, newVaultKey) => {
			const oldVaultKeyBase64 = toBase64(keys.read(oldVaultKey));
			const newVaultKeyBase64 = toBase64(keys.read(newVaultKey));
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_re_encrypt_item", {
					item: toTauriItem(item),
					oldVaultKeyBase64,
					newVaultKeyBase64,
				}),
			);
			return {
				itemId: response.item_id,
				encryptedData: response.encrypted_data,
				encryptionIv: response.encryption_iv,
			};
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
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_perform_key_rotation", {
					oldVaultKeyBase64,
					members: members.map(toTauriMember),
					items: items.map(toTauriItem),
					vaultId,
					keyVersion,
					currentUserId,
					masterUnlockKeyBase64,
				}),
			);
			return {
				memberEncryptedKeys: response.member_encrypted_keys.map((member) => ({
					userId: member.user_id,
					encryptedVaultKey: member.encrypted_vault_key,
				})),
				reEncryptedItems: response.re_encrypted_items.map((item) => ({
					itemId: item.item_id,
					encryptedData: item.encrypted_data,
					encryptionIv: item.encryption_iv,
				})),
			};
		},

		validateRotationData: async (members) => {
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_validate_rotation_data", {
					members: members.map(toTauriMember),
				}),
			);
			return { valid: response.valid, errors: response.errors };
		},

		// ------------------------------------------------------------------
		// Secret Key
		// ------------------------------------------------------------------

		generateSecretKey: async () => {
			const invoke = await ensureInvoke();
			return withPortErrors(() => invoke("crypto_generate_secret_key"));
		},

		validateSecretKey: async (secretKey) => {
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_validate_secret_key", { secretKey }),
			);
		},

		// ------------------------------------------------------------------
		// Recovery
		// ------------------------------------------------------------------

		generateRecoveryKey: async () => {
			const invoke = await ensureInvoke();
			return withPortErrors(() => invoke("crypto_generate_recovery_key"));
		},

		validateRecoveryKey: async (recoveryKey) => {
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_validate_recovery_key", { recoveryKey }),
			);
		},

		encryptMasterKey: async (masterKey, recoveryKey, email) => {
			const masterKeyBase64 = toBase64(keys.read(masterKey));
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_encrypt_master_key", {
					masterKeyBase64,
					recoveryKey,
					email,
				}),
			);
		},

		decryptMasterKey: async (data, recoveryKey, email) => {
			const invoke = await ensureInvoke();
			const masterKeyBase64 = await withPortErrors(() =>
				invoke("crypto_decrypt_master_key", {
					ciphertext: data.ciphertext,
					iv: data.iv,
					algorithm: data.algorithm,
					recoveryKey,
					email,
				}),
			);
			return keys.create(fromBase64(masterKeyBase64));
		},

		// ------------------------------------------------------------------
		// SRP-6a client
		// ------------------------------------------------------------------

		generateSrpRegistration: async (password) => {
			const invoke = await ensureInvoke();
			const salt = await withPortErrors(() =>
				invoke("crypto_srp_generate_salt"),
			);
			const privateKey = await withPortErrors(() =>
				invoke("crypto_srp_derive_safe_private_key", {
					salt,
					password,
					iterations: null,
				}),
			);
			const verifier = await withPortErrors(() =>
				invoke("crypto_srp_derive_verifier", { privateKey }),
			);
			return { salt, verifier };
		},

		generateClientEphemeral: async () => {
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_srp_generate_ephemeral"),
			);
			return { publicKey: response.public, secret: response.secret };
		},

		deriveClientSession: async (clientEphemeralSecret, challenge, password) => {
			const invoke = await ensureInvoke();
			// The username is empty because the private key already binds the salt — the
			// same choice `apps/desktop/src/lib/tauri-crypto.ts` and every wasm adapter make,
			// and `challenge.kdfParams` is unused for the same reason S5 recorded: passing it
			// into the private-key derivation would change the verifier and break server
			// interop, so it stays a decision for whoever owns SRP, not this adapter.
			const privateKey = await withPortErrors(() =>
				invoke("crypto_srp_derive_safe_private_key", {
					salt: challenge.salt,
					password,
					iterations: null,
				}),
			);
			const response = await withPortErrors(() =>
				invoke("crypto_srp_derive_session", {
					clientSecretEphemeral: clientEphemeralSecret,
					serverPublicEphemeral: challenge.serverPublicKey,
					salt: challenge.salt,
					username: "",
					privateKey,
				}),
			);
			return { key: response.key, proof: response.proof };
		},

		verifyServerSession: async (
			clientPublicEphemeral,
			session,
			serverSessionProof,
		) => {
			const invoke = await ensureInvoke();
			await withPortErrors(() =>
				invoke("crypto_srp_verify_session", {
					clientPublicEphemeral,
					sessionKey: session.key,
					sessionProof: session.proof,
					serverSessionProof,
				}),
			);
		},

		// ------------------------------------------------------------------
		// Passkey / WebAuthn
		// ------------------------------------------------------------------

		generatePasskeyKeypair: async () => {
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_passkey_generate_keypair"),
			);
			return {
				privateKey: response.private_key,
				publicKeyCose: response.public_key_cose,
			};
		},

		generatePasskeyCredentialId: async () => {
			const invoke = await ensureInvoke();
			return withPortErrors(() =>
				invoke("crypto_passkey_generate_credential_id"),
			);
		},

		buildPasskeyAttestationObject: async (
			rpId,
			credentialIdBase64,
			cosePublicKeyBase64,
			signCount,
		) => {
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_passkey_build_attestation_object", {
					rpId,
					credentialIdBase64,
					cosePublicKeyBase64,
					signCount,
				}),
			);
			return {
				authenticatorData: fromBase64(response.authenticator_data),
				attestationObject: fromBase64(response.attestation_object),
			};
		},

		signPasskeyAssertion: async (
			privateKeyBase64,
			rpId,
			clientDataHashBase64,
			signCount,
		) => {
			const invoke = await ensureInvoke();
			const response = await withPortErrors(() =>
				invoke("crypto_passkey_sign_assertion", {
					privateKeyBase64,
					rpId,
					clientDataHashBase64,
					signCount,
				}),
			);
			return {
				authenticatorData: fromBase64(response.authenticator_data),
				signatureDer: fromBase64(response.signature_der),
			};
		},

		// ------------------------------------------------------------------
		// Identifiers
		// ------------------------------------------------------------------

		generateUuid: async () => {
			const invoke = await ensureInvoke();
			return withPortErrors(() => invoke("crypto_generate_uuid"));
		},
	};

	return port;
}
