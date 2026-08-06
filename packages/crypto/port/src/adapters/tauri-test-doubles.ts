/**
 * An in-process double for the one thing this adapter loads: Tauri's `invoke`.
 *
 * `bun test` has no Tauri IPC to answer `invoke("crypto_*", …)`, so the adapter reaches it
 * through its `TauriDeps` seam and a test supplies this instead — the **real** adapter code
 * runs against it, only the transport is faked.
 *
 * Unlike the wasm doubles, there is no key-handle store to reproduce here: every
 * `crypto_*` command in `apps/desktop/src-tauri/src/crypto_commands.rs` is stateless and
 * takes key material as a plain base64 argument, so this double is a pure function of its
 * arguments — no `bigint` handle table, because the real Rust side has none either.
 *
 * **The cipher below is a toy and protects nothing** — a keyed XOR mask over a JSON payload
 * carrying a key fingerprint and the AAD, the same shape `in-memory-crypto.ts` and the wasm
 * doubles use. What is real is the vocabulary: every thrown message is either the literal
 * `Display` string of `bittery_crypto_core::CryptoError` (read from `error.rs`,
 * `key_rotation.rs`, `recovery.rs`) or `crypto_commands.rs`'s own `format!("Invalid {x}
 * base64: {}", e)` guard, because those are exactly the strings `classify` in `tauri.ts`
 * reads — a double with the wrong wording would let a mistranslated error code through.
 *
 * Nothing here is exported to production code.
 */

import type { TauriDeps, TauriInvoke } from "./tauri";

// ============================================================================
// Formats the double reproduces, from the crate that owns them
// ============================================================================

const KEY_LENGTH = 32;
const ALGORITHM = "AES-GCM-AAD-V1";
/** Base32 without the confusable characters, from `secret_key.rs`. */
const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SECRET_KEY_PREFIX = "A3";
const SECRET_KEY_SEGMENTS = [6, 6, 5, 5, 5];
const RECOVERY_KEY_PREFIX = "R1";
const RECOVERY_KEY_SEGMENTS = [6, 6, 5, 5, 5, 5, 5];
const VAULT_KEY_WRAP_PURPOSE = "vault-key-wrap";
const PUBLIC_KEY_MARKER = "-----BEGIN PUBLIC KEY-----";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

// ============================================================================
// Bytes, base64 and a spreader
// ============================================================================

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/**
 * `encryption.rs::decrypt_internal`'s own decode — `BASE64.decode(&encrypted_data.ciphertext)?`
 * relies on `CryptoError`'s `From<base64::DecodeError>`, whose `Display` is "Base64 decode
 * error: {0}" verbatim, with no argument name attached. Used for ciphertext/iv, which are
 * never pre-decoded at the command layer, whether top-level or nested in an `ItemData`.
 */
function fromBase64(value: string): Uint8Array {
	let binary: string;
	try {
		binary = atob(value);
	} catch (cause) {
		throw new Error(`Base64 decode error: ${String(cause)}`);
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/**
 * `crypto_commands.rs`'s own `format!("Invalid {label} base64: {}", e)` guard, which runs
 * in the command wrapper itself — before core ever sees the argument — for every top-level
 * `*_base64` command parameter (`key_base64`, `vault_key_base64`, `credential_id_base64`, …).
 */
function fromBase64Arg(value: string, label: string): Uint8Array {
	try {
		return fromBase64(value);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Invalid ${label} base64: ${message}`);
	}
}

/** FNV-1a, 32-bit. Not a hash in any security sense; a spreader. */
function fnv1a(seed: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index++) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/**
 * The index goes in front of the seed, not after — FNV-1a's low byte otherwise depends only
 * on the low byte of the state before it, so the whole expansion would take just 256 distinct
 * values however long it is, and two different passwords would derive the same key roughly
 * once in 256 tries (the collision S5 found and fixed in the wasm doubles). Putting the index
 * first makes each byte an independent 8-bit hash of the entire seed.
 */
function expandBytes(seed: string, length: number): Uint8Array {
	const out = new Uint8Array(length);
	for (let index = 0; index < length; index++) {
		out[index] = fnv1a(`${index}#${seed}`) & 0xff;
	}
	return out;
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expandHex(seed: string, byteLength: number): string {
	return toHex(expandBytes(seed, byteLength));
}

function randomHex(byteLength: number): string {
	return toHex(randomBytes(byteLength));
}

function fingerprint(bytes: Uint8Array): string {
	return fnv1a(toBase64(bytes)).toString(16);
}

/** `identity::normalize_email`. */
function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

// ============================================================================
// The toy cipher — mirrors encryption.rs's shape, not its bytes
// ============================================================================

interface Sealed {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

function mask(bytes: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
	if (key.length === 0 || iv.length === 0) {
		throw new Error("Invalid input: empty key or IV");
	}
	const out = new Uint8Array(bytes.length);
	for (let index = 0; index < bytes.length; index++) {
		out[index] =
			(bytes[index] ?? 0) ^
			(key[index % key.length] ?? 0) ^
			(iv[index % iv.length] ?? 0) ^
			(index & 0xff);
	}
	return out;
}

interface CanonicalAad {
	vaultId: string;
	entityId: string;
	entityType: string;
	version: number;
	userId: string;
}

/** `null` and a context are distinct values, never both the empty string. */
function aadOf(context: CanonicalAad | null): string {
	if (context === null) {
		return " none";
	}
	return [
		context.vaultId,
		context.entityId,
		context.entityType,
		String(context.version),
		context.userId,
	].join(" ");
}

function seal(plaintext: string, key: Uint8Array, aad: string): Sealed {
	const iv = randomBytes(12);
	const payload = JSON.stringify({ p: plaintext, a: aad, k: fingerprint(key) });
	return {
		ciphertext: toBase64(mask(utf8Encoder.encode(payload), key, iv)),
		iv: toBase64(iv),
		algorithm: ALGORITHM,
	};
}

function open(data: Sealed, key: Uint8Array, aad: string): string {
	if (data.algorithm !== ALGORITHM) {
		throw new Error(
			`Decryption failed: unsupported algorithm ${data.algorithm}`,
		);
	}
	// `decrypt_internal` decodes ciphertext/iv *before* touching the AEAD, so a malformed
	// base64 argument surfaces as `CryptoError::Base64Decode`'s own "Base64 decode error: …"
	// rather than being folded into a decryption failure — decoded outside the try below.
	const ciphertext = fromBase64(data.ciphertext);
	const iv = fromBase64(data.iv);
	let payload: { p?: unknown; a?: unknown; k?: unknown };
	try {
		payload = JSON.parse(utf8Decoder.decode(mask(ciphertext, key, iv))) as {
			p?: unknown;
			a?: unknown;
			k?: unknown;
		};
	} catch {
		throw new Error("Decryption failed: aead::Error");
	}
	if (
		typeof payload.p !== "string" ||
		payload.k !== fingerprint(key) ||
		payload.a !== aad
	) {
		throw new Error("Decryption failed: aead::Error");
	}
	return payload.p;
}

// ============================================================================
// Fake RSA and the formatted keys
// ============================================================================

function pem(label: string, body: string): string {
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

function keyPairIdFrom(value: string, kind: "public" | "private"): string {
	const found = new RegExp(`fake-rsa-${kind}:([0-9a-f]+)`).exec(value);
	if (found?.[1] === undefined) {
		throw new Error(`Invalid PEM format: Invalid ${kind} key PEM`);
	}
	return found[1];
}

function generateFormattedKey(
	prefix: string,
	segments: readonly number[],
): string {
	const parts = segments.map((length) =>
		[...randomBytes(length)]
			.map((byte) => CHARSET[byte % CHARSET.length])
			.join(""),
	);
	return [prefix, ...parts].join("-");
}

function isFormattedKey(
	value: string,
	prefix: string,
	segments: readonly number[],
): boolean {
	const parts = value.split("-");
	if (parts.length !== segments.length + 1 || parts[0] !== prefix) {
		return false;
	}
	return segments.every((length, index) => {
		const segment = parts[index + 1] ?? "";
		return (
			segment.length === length &&
			[...segment].every((character) => CHARSET.includes(character))
		);
	});
}

function recoveryKeyBytes(recoveryKey: string, email: string): Uint8Array {
	if (
		!isFormattedKey(recoveryKey, RECOVERY_KEY_PREFIX, RECOVERY_KEY_SEGMENTS)
	) {
		throw new Error("Invalid input: Invalid recovery key format");
	}
	return expandBytes(
		`recovery|${recoveryKey}|${normalizeEmail(email)}`,
		KEY_LENGTH,
	);
}

// ============================================================================
// Derivation
// ============================================================================

function deriveMasterKeyBytes(
	accountPassword: string,
	secretKey: string,
	email: string,
	schemaVersion: number,
	algorithm: string,
	iterations: number,
): Uint8Array {
	return expandBytes(
		[
			"master",
			accountPassword,
			secretKey,
			normalizeEmail(email),
			schemaVersion,
			algorithm,
			iterations,
		].join("|"),
		KEY_LENGTH,
	);
}

function deriveKeysFromMasterKeyBytes(
	masterKey: Uint8Array,
	email: string,
): { authKey: Uint8Array; masterUnlockKey: Uint8Array } {
	const seed = `${fingerprint(masterKey)}|${normalizeEmail(email)}`;
	return {
		authKey: expandBytes(`auth|${seed}`, KEY_LENGTH),
		masterUnlockKey: expandBytes(`muk|${seed}`, KEY_LENGTH),
	};
}

// ============================================================================
// Vault key wrap envelope — matches key_rotation.rs's WrappedVaultKeyData
// ============================================================================

function wrapWithMuk(
	vaultKey: Uint8Array,
	masterUnlockKey: Uint8Array,
	vaultId: string,
	userId: string,
	keyVersion: number,
): string {
	const encrypted = seal(
		toBase64(vaultKey),
		masterUnlockKey,
		aadOf({
			vaultId,
			entityId: VAULT_KEY_WRAP_PURPOSE,
			entityType: "vault_key",
			version: keyVersion,
			userId,
		}),
	);
	return JSON.stringify({
		...encrypted,
		context: { vaultId, userId, keyVersion, purpose: VAULT_KEY_WRAP_PURPOSE },
	});
}

function rotateItem(
	item: {
		id: string;
		encrypted_data: string;
		encryption_iv: string;
		encryption_algorithm: string;
	},
	oldKey: Uint8Array,
	newKey: Uint8Array,
): { item_id: string; encrypted_data: string; encryption_iv: string } {
	const plaintext = open(
		{
			ciphertext: item.encrypted_data,
			iv: item.encryption_iv,
			algorithm: item.encryption_algorithm,
		},
		oldKey,
		aadOf(null),
	);
	const resealed = seal(plaintext, newKey, aadOf(null));
	return {
		item_id: item.id,
		encrypted_data: resealed.ciphertext,
		encryption_iv: resealed.iv,
	};
}

function rsaEncryptBase64(plaintext: string, publicKeyPem: string): string {
	const id = keyPairIdFrom(publicKeyPem, "public");
	return toBase64(utf8Encoder.encode(JSON.stringify({ id, p: plaintext })));
}

// ============================================================================
// The double
// ============================================================================

/** One recorded `invoke` call, so a test can prove which commands a member actually uses. */
export interface InvokeCall {
	cmd: string;
	args: Record<string, unknown> | undefined;
}

/**
 * `apps/desktop/src-tauri/src/crypto_commands.rs`, in memory.
 *
 * Stateless, exactly like the real commands: nothing here remembers a key between calls, so
 * there is no handle table to leak or to assert against — only the values each call is given.
 */
export class TauriCryptoDouble {
	readonly calls: InvokeCall[] = [];

	/** When set, the next call to any command rejects with it instead of answering. */
	nextFailure: unknown = null;

	readonly invoke: TauriInvoke = (async (
		cmd: string,
		args?: Record<string, unknown>,
	): Promise<unknown> => {
		this.calls.push({ cmd, args });
		if (this.nextFailure !== null) {
			const failure = this.nextFailure;
			this.nextFailure = null;
			throw failure;
		}
		return this.dispatch(cmd, args ?? {});
	}) as TauriInvoke;

	/** Calls to `cmd`, in order. */
	callsTo(cmd: string): InvokeCall[] {
		return this.calls.filter((call) => call.cmd === cmd);
	}

	private dispatch(cmd: string, args: Record<string, unknown>): unknown {
		switch (cmd) {
			case "crypto_derive_keys": {
				const masterKey = deriveMasterKeyBytes(
					args.password as string,
					args.secretKey as string,
					args.email as string,
					args.schemaVersion as number,
					args.algorithm as string,
					args.iterations as number,
				);
				const { authKey, masterUnlockKey } = deriveKeysFromMasterKeyBytes(
					masterKey,
					args.email as string,
				);
				return {
					auth_key: toBase64(authKey),
					master_unlock_key: toBase64(masterUnlockKey),
				};
			}

			case "crypto_derive_master_key": {
				return toBase64(
					deriveMasterKeyBytes(
						args.accountPassword as string,
						args.secretKey as string,
						args.email as string,
						args.schemaVersion as number,
						args.algorithm as string,
						args.iterations as number,
					),
				);
			}

			case "crypto_derive_keys_from_master_key": {
				const masterKey = fromBase64Arg(
					args.masterKeyBase64 as string,
					"master key",
				);
				const { authKey, masterUnlockKey } = deriveKeysFromMasterKeyBytes(
					masterKey,
					args.email as string,
				);
				return {
					auth_key: toBase64(authKey),
					master_unlock_key: toBase64(masterUnlockKey),
				};
			}

			case "crypto_encrypt": {
				const key = fromBase64Arg(args.keyBase64 as string, "key");
				return seal(args.plaintext as string, key, aadOf(null));
			}

			case "crypto_encrypt_with_context": {
				const key = fromBase64Arg(args.keyBase64 as string, "key");
				return seal(
					args.plaintext as string,
					key,
					aadOf({
						vaultId: args.vaultId as string,
						entityId: args.entityId as string,
						entityType: args.entityType as string,
						version: args.version as number,
						userId: args.userId as string,
					}),
				);
			}

			case "crypto_decrypt": {
				const key = fromBase64Arg(args.keyBase64 as string, "key");
				return open(
					{
						ciphertext: args.ciphertext as string,
						iv: args.iv as string,
						algorithm: args.algorithm as string,
					},
					key,
					aadOf(null),
				);
			}

			case "crypto_decrypt_with_context": {
				const key = fromBase64Arg(args.keyBase64 as string, "key");
				return open(
					{
						ciphertext: args.ciphertext as string,
						iv: args.iv as string,
						algorithm: args.algorithm as string,
					},
					key,
					aadOf({
						vaultId: args.vaultId as string,
						entityId: args.entityId as string,
						entityType: args.entityType as string,
						version: args.version as number,
						userId: args.userId as string,
					}),
				);
			}

			case "crypto_generate_encryption_key":
				return toBase64(randomBytes(KEY_LENGTH));

			case "crypto_generate_uuid":
				return generateUuidV4();

			case "crypto_generate_rsa_key_pair": {
				const id = randomHex(16);
				return {
					public_key: pem("PUBLIC KEY", `fake-rsa-public:${id}`),
					private_key: pem("PRIVATE KEY", `fake-rsa-private:${id}`),
				};
			}

			case "crypto_rsa_encrypt":
				return rsaEncryptBase64(
					args.plaintext as string,
					args.publicKeyPem as string,
				);

			case "crypto_rsa_decrypt": {
				const id = keyPairIdFrom(args.privateKeyPem as string, "private");
				// `rsa_decrypt` (core) decodes the ciphertext itself, before ever touching
				// the private key — a malformed argument is a bare "Base64 decode error: …",
				// not wrapped as "RSA operation failed: …" the way an OAEP failure is.
				const ciphertextBytes = fromBase64(args.ciphertext as string);
				let payload: { id?: unknown; p?: unknown };
				try {
					payload = JSON.parse(utf8Decoder.decode(ciphertextBytes)) as {
						id?: unknown;
						p?: unknown;
					};
				} catch {
					throw new Error(
						"RSA operation failed: Decryption failed: decoding error",
					);
				}
				if (payload.id !== id || typeof payload.p !== "string") {
					throw new Error(
						"RSA operation failed: Decryption failed: decoding error",
					);
				}
				return payload.p;
			}

			case "crypto_generate_secret_key":
				return generateFormattedKey(SECRET_KEY_PREFIX, SECRET_KEY_SEGMENTS);

			case "crypto_validate_secret_key":
				return isFormattedKey(
					args.secretKey as string,
					SECRET_KEY_PREFIX,
					SECRET_KEY_SEGMENTS,
				);

			case "crypto_generate_recovery_key":
				return generateFormattedKey(RECOVERY_KEY_PREFIX, RECOVERY_KEY_SEGMENTS);

			case "crypto_validate_recovery_key":
				return isFormattedKey(
					args.recoveryKey as string,
					RECOVERY_KEY_PREFIX,
					RECOVERY_KEY_SEGMENTS,
				);

			case "crypto_encrypt_master_key": {
				const masterKey = fromBase64Arg(
					args.masterKeyBase64 as string,
					"master key",
				);
				if (masterKey.length !== KEY_LENGTH) {
					throw new Error(
						`Invalid key length: expected ${KEY_LENGTH}, got ${masterKey.length}`,
					);
				}
				const encryptionKey = recoveryKeyBytes(
					args.recoveryKey as string,
					args.email as string,
				);
				return seal(toBase64(masterKey), encryptionKey, aadOf(null));
			}

			case "crypto_decrypt_master_key": {
				const encryptionKey = recoveryKeyBytes(
					args.recoveryKey as string,
					args.email as string,
				);
				const decoded = open(
					{
						ciphertext: args.ciphertext as string,
						iv: args.iv as string,
						algorithm: args.algorithm as string,
					},
					encryptionKey,
					aadOf(null),
				);
				// `decrypt_master_key` (core, `recovery.rs`) decodes the AES output itself —
				// `BASE64.decode(&encoded_master_key)?` — with no command-layer wrapper.
				const masterKey = fromBase64(decoded);
				if (masterKey.length !== KEY_LENGTH) {
					throw new Error(
						`Invalid key length: expected ${KEY_LENGTH}, got ${masterKey.length}`,
					);
				}
				return decoded;
			}

			case "crypto_srp_generate_salt":
				return randomHex(16);

			case "crypto_srp_derive_safe_private_key":
				return expandHex(
					`private|${args.salt as string}|${args.password as string}`,
					32,
				);

			case "crypto_srp_derive_verifier":
				return expandHex(`verifier|${args.privateKey as string}`, 32);

			case "crypto_srp_generate_ephemeral":
				return { public: randomHex(32), secret: randomHex(32) };

			case "crypto_srp_derive_session": {
				const seed = [
					args.clientSecretEphemeral as string,
					args.serverPublicEphemeral as string,
					args.salt as string,
					args.username as string,
					args.privateKey as string,
				].join("|");
				return {
					key: expandHex(`session-key|${seed}`, 32),
					proof: expandHex(`session-proof|${seed}`, 32),
				};
			}

			case "crypto_srp_verify_session": {
				const expected = expandHex(
					`server-proof|${args.clientPublicEphemeral as string}|${args.sessionKey as string}|${args.sessionProof as string}`,
					32,
				);
				if ((args.serverSessionProof as string) !== expected) {
					throw new Error("Invalid session proof");
				}
				return undefined;
			}

			case "crypto_passkey_generate_keypair": {
				const privateKey = randomBytes(KEY_LENGTH);
				return {
					private_key: toBase64(privateKey),
					public_key_cose: toBase64(
						expandBytes(`cose|${fingerprint(privateKey)}`, KEY_LENGTH),
					),
				};
			}

			case "crypto_passkey_generate_credential_id":
				return toBase64(randomBytes(KEY_LENGTH));

			case "crypto_passkey_build_attestation_object": {
				const credentialId = fromBase64Arg(
					args.credentialIdBase64 as string,
					"credential id",
				);
				const cosePublicKey = fromBase64Arg(
					args.cosePublicKeyBase64 as string,
					"public key",
				);
				const signCount = (args.signCount as number | undefined) ?? 0;
				const authenticatorData = Uint8Array.from([
					...expandBytes(`rp|${args.rpId as string}`, KEY_LENGTH),
					0x45,
					...expandBytes(`count|${signCount}`, 4),
					...credentialId,
					...cosePublicKey,
				]);
				return {
					authenticator_data: toBase64(authenticatorData),
					attestation_object: toBase64(
						utf8Encoder.encode(
							JSON.stringify({
								fmt: "none",
								authData: toBase64(authenticatorData),
							}),
						),
					),
				};
			}

			case "crypto_passkey_sign_assertion": {
				const privateKeyBase64 = args.privateKeyBase64 as string;
				// Rejects a malformed key or client data hash the way `crypto_commands.rs`
				// does — both are decoded before signing anything is attempted.
				fromBase64Arg(privateKeyBase64, "private key");
				fromBase64Arg(args.clientDataHashBase64 as string, "client data hash");
				const signCount = args.signCount as number;
				const authenticatorData = Uint8Array.from([
					...expandBytes(`rp|${args.rpId as string}`, KEY_LENGTH),
					0x05,
					...expandBytes(`count|${signCount}`, 4),
				]);
				return {
					authenticator_data: toBase64(authenticatorData),
					signature_der: toBase64(
						expandBytes(
							`sig|${privateKeyBase64}|${toBase64(authenticatorData)}|${args.clientDataHashBase64 as string}`,
							64,
						),
					),
				};
			}

			case "crypto_encrypt_vault_key_for_member": {
				const vaultKey = fromBase64Arg(
					args.vaultKeyBase64 as string,
					"vault key",
				);
				return rsaEncryptBase64(
					toBase64(vaultKey),
					args.memberPublicKey as string,
				);
			}

			case "crypto_encrypt_vault_key_with_muk": {
				const vaultKey = fromBase64Arg(
					args.vaultKeyBase64 as string,
					"vault key",
				);
				const muk = fromBase64Arg(args.masterUnlockKeyBase64 as string, "MUK");
				return wrapWithMuk(
					vaultKey,
					muk,
					args.vaultId as string,
					args.userId as string,
					args.keyVersion as number,
				);
			}

			case "crypto_re_encrypt_item": {
				const oldKey = fromBase64Arg(
					args.oldVaultKeyBase64 as string,
					"old key",
				);
				const newKey = fromBase64Arg(
					args.newVaultKeyBase64 as string,
					"new key",
				);
				return rotateItem(
					args.item as {
						id: string;
						encrypted_data: string;
						encryption_iv: string;
						encryption_algorithm: string;
					},
					oldKey,
					newKey,
				);
			}

			case "crypto_perform_key_rotation": {
				const oldKey = fromBase64Arg(
					args.oldVaultKeyBase64 as string,
					"old key",
				);
				const muk = fromBase64Arg(args.masterUnlockKeyBase64 as string, "MUK");
				const newKey = randomBytes(KEY_LENGTH);
				const members = args.members as Array<{
					user_id: string;
					public_key: string;
				}>;
				const items = args.items as Array<{
					id: string;
					encrypted_data: string;
					encryption_iv: string;
					encryption_algorithm: string;
				}>;
				const currentUserId = args.currentUserId as string;

				const memberEncryptedKeys = members.map((member) => ({
					user_id: member.user_id,
					encrypted_vault_key:
						member.user_id === currentUserId
							? wrapWithMuk(
									newKey,
									muk,
									args.vaultId as string,
									currentUserId,
									args.keyVersion as number,
								)
							: rsaEncryptBase64(toBase64(newKey), member.public_key),
				}));
				const reEncryptedItems = items.map((item) =>
					rotateItem(item, oldKey, newKey),
				);
				newKey.fill(0);
				return {
					member_encrypted_keys: memberEncryptedKeys,
					re_encrypted_items: reEncryptedItems,
				};
			}

			case "crypto_validate_rotation_data": {
				const members = args.members as Array<{
					user_id: string;
					public_key: string;
				}>;
				const errors = members.flatMap((member) => {
					if (member.public_key.length === 0) {
						return [`Member ${member.user_id} has no public key`];
					}
					if (!member.public_key.includes(PUBLIC_KEY_MARKER)) {
						return [`Member ${member.user_id} has invalid public key format`];
					}
					return [];
				});
				return { valid: errors.length === 0, errors };
			}

			default:
				throw new Error(`Unexpected Tauri command "${cmd}" from a crypto port`);
		}
	}
}

function generateUuidV4(): string {
	const bytes = randomBytes(16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = toHex(bytes);
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

// ============================================================================
// Wiring into TauriDeps
// ============================================================================

export interface TauriDoubles {
	/** Pass this to `createTauriCryptoPort`. */
	deps: TauriDeps;
	backend: TauriCryptoDouble;
	/** How many times the adapter asked for `invoke`. Should never exceed one. */
	readonly invokeLoads: number;
}

export interface TauriDoublesOptions {
	/** Simulate `@tauri-apps/api/core` not being available. */
	invokeModuleMissing?: boolean;
}

/** A fresh, empty double plus the `TauriDeps` that hand it out. */
export function createTauriDoubles(
	options: TauriDoublesOptions = {},
): TauriDoubles {
	const backend = new TauriCryptoDouble();
	let invokeLoads = 0;

	return {
		deps: {
			loadInvoke: async () => {
				invokeLoads += 1;
				if (options.invokeModuleMissing === true) {
					throw new Error("Cannot find module '@tauri-apps/api/core'");
				}
				return backend.invoke;
			},
		},
		backend,
		get invokeLoads() {
			return invokeLoads;
		},
	};
}
