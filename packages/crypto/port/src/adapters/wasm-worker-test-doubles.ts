/**
 * In-process doubles for the two things the web adapter loads: the `Worker` global and
 * `@bittery/crypto-wasm`.
 *
 * `bun test` has neither. The WASM package is built `--target web`, so it cannot be
 * instantiated here at all, and there is no worker thread for the adapter to talk to. Both
 * reach the adapter through seams — `WasmWorkerDeps.createWorker` and `LoadCryptoWasm` —
 * so a test supplies these and the **real** adapter and the **real** serving loop run
 * against them.
 *
 * Two things make these doubles worth trusting more than a hand-written fake usually is:
 *
 *   1. `CryptoWasmDouble implements CryptoWasm`, and `CryptoWasm` is the same declaration
 *      `wasm.worker.ts` returns the real `@bittery/crypto-wasm` namespace as. So the
 *      compiler compares the double's signatures against `bittery_crypto.d.ts` for us:
 *      wrong argument order, a missing member, `number` where the binding wants `bigint`,
 *      snake_case where the binding is camelCase — all of it fails the build.
 *   2. `WorkerDouble` puts every message through `structuredClone`, exactly as a real
 *      `postMessage` would. A `KeyRef` token, a `Map`, a class instance or a function that
 *      escaped the adapter's encoder throws here instead of quietly arriving as `{}`.
 *
 * What they cannot prove is the algorithms. **The cipher below is a toy and protects
 * nothing** — a keyed XOR mask over a JSON payload carrying a key fingerprint and the AAD,
 * the same shape `in-memory-crypto.ts` uses. Its error *messages* are the real
 * `bittery_crypto_core::CryptoError` `Display` strings, because those are what the
 * worker's classifier reads; its ciphertext is meaningless to real WASM.
 *
 * Nothing here is exported to production code.
 */

import type {
	CryptoWasm,
	CryptoWorkerScope,
	LoadCryptoWasm,
	WasmAadContext,
	WasmDerivedKeyHandles,
	WasmEncryptedData,
	WasmItemData,
	WasmKeyRotationResult,
	WasmPasskeyAssertion,
	WasmPasskeyAttestation,
	WasmPasskeyKeypair,
	WasmReEncryptedItem,
	WasmRsaKeyPair,
	WasmSrpClient,
	WasmSrpEphemeral,
	WasmSrpSession,
	WasmValidationResult,
} from "../wasm.worker";
import { serveCryptoPort } from "../wasm.worker";
import type {
	CryptoPortCall,
	CryptoPortReply,
	CryptoWorkerHandle,
	WasmWorkerDeps,
} from "./wasm-worker";

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
const lossyUtf8Decoder = new TextDecoder();

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
 * The index goes in FRONT of the seed. FNV-1a's low byte depends only on the low byte of
 * the state before it, so with the seed first every output byte is a function of one 8-bit
 * value and the whole expansion takes just 256 distinct values however long it is — two
 * different passwords would derive the same key roughly once in 256 tries. Putting the
 * index first makes each byte an independent 8-bit hash of the entire seed.
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
// The toy cipher
// ============================================================================

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

/** Canonical AAD. `null` and a context are distinct values, never both `""`. */
function aadOf(context: WasmAadContext | null): string {
	if (context === null) {
		return " none";
	}
	return [
		context.vault_id,
		context.entity_id,
		context.entity_type,
		String(context.version),
		context.user_id,
	].join(" ");
}

function seal(
	plaintext: string,
	key: Uint8Array,
	aad: string,
): WasmEncryptedData {
	const iv = randomBytes(12);
	const payload = JSON.stringify({
		p: plaintext,
		a: aad,
		k: fingerprint(key),
	});
	return {
		ciphertext: toBase64(mask(utf8Encoder.encode(payload), key, iv)),
		iv: toBase64(iv),
		algorithm: ALGORITHM,
	};
}

function open(data: WasmEncryptedData, key: Uint8Array, aad: string): string {
	if (data.algorithm !== ALGORITHM) {
		throw new Error(
			`Decryption failed: unsupported algorithm ${data.algorithm}`,
		);
	}
	let payload: { p?: unknown; a?: unknown; k?: unknown };
	try {
		payload = JSON.parse(
			utf8Decoder.decode(
				mask(fromBase64(data.ciphertext), key, fromBase64(data.iv)),
			),
		) as { p?: unknown; a?: unknown; k?: unknown };
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

// ============================================================================
// The binding's value types
// ============================================================================

class AadContextDouble implements WasmAadContext {
	constructor(
		public vault_id: string,
		public entity_id: string,
		public entity_type: string,
		public version: bigint,
		public user_id: string,
	) {}
}

class EncryptedDataDouble implements WasmEncryptedData {
	constructor(
		public ciphertext: string,
		public iv: string,
		public algorithm: string,
	) {}
}

class ItemDataDouble implements WasmItemData {
	constructor(
		public id: string,
		public encrypted_data: string,
		public encryption_iv: string,
		public encryption_algorithm: string,
	) {}
}

/**
 * `JsSrpClient`, in memory.
 *
 * The proofs are derived rather than computed, but the shape the port depends on is exact:
 * `deriveSession` is deterministic in salt, password and both ephemerals, and
 * `verifySession` throws `Invalid session proof` — the `Display` of
 * `CryptoError::InvalidSessionProof` — which is what the worker maps to
 * `verification-failed`.
 */
class SrpClientDouble implements WasmSrpClient {
	generateSalt(): string {
		return randomHex(16);
	}

	deriveSafePrivateKey(salt: string, password: string): string {
		return expandHex(`private|${salt}|${password}`, 32);
	}

	deriveVerifier(privateKey: string): string {
		return expandHex(`verifier|${privateKey}`, 32);
	}

	generateEphemeral(): WasmSrpEphemeral {
		return { public: randomHex(32), secret: randomHex(32) };
	}

	deriveSession(
		clientSecretEphemeral: string,
		serverPublicEphemeral: string,
		salt: string,
		username: string,
		privateKey: string,
	): WasmSrpSession {
		const seed = [
			clientSecretEphemeral,
			serverPublicEphemeral,
			salt,
			username,
			privateKey,
		].join("|");
		return {
			key: expandHex(`session-key|${seed}`, 32),
			proof: expandHex(`session-proof|${seed}`, 32),
		};
	}

	verifySession(
		clientPublicEphemeral: string,
		session: WasmSrpSession,
		serverSessionProof: string,
	): void {
		const expected = expandHex(
			`server-proof|${clientPublicEphemeral}|${session.key}|${session.proof}`,
			32,
		);
		if (serverSessionProof !== expected) {
			throw new Error("Invalid session proof");
		}
	}
}

// ============================================================================
// @bittery/crypto-wasm, in memory
// ============================================================================

/**
 * The WASM binding, in memory, including its key-handle store.
 *
 * The store is the part that matters most: handles are `bigint`s counting from 1, a
 * handle the store does not hold raises `Invalid or expired key handle`, and destroying
 * one zeroizes its bytes — the same three facts `KEY_HANDLE_STORE` in
 * `bittery-crypto-wasm/src/lib.rs` provides.
 */
export class CryptoWasmDouble implements CryptoWasm {
	readonly JsAadContext = AadContextDouble;
	readonly JsEncryptedData = EncryptedDataDouble;
	readonly JsItemData = ItemDataDouble;
	readonly JsSrpClient = SrpClientDouble;

	/** Handles minted and not yet destroyed — the worker's own key accounting. */
	get liveHandleCount(): number {
		return this.handles.size;
	}

	/**
	 * When set, the next `generateUuid` throws it. One cheap failure path is enough to
	 * pin the worker's error classifier against real `CryptoError` strings without
	 * growing a hook on all 38 members.
	 */
	nextUuidFailure: unknown = null;

	private readonly handles = new Map<bigint, Uint8Array>();
	private nextHandle = 1n;

	// ------------------------------------------------------------------
	// Key handles
	// ------------------------------------------------------------------

	importKeyHandle(keyBase64: string): bigint {
		return this.insert(fromBase64(keyBase64));
	}

	exportKeyHandle(keyHandle: bigint): string {
		return toBase64(this.material(keyHandle));
	}

	cloneKeyHandle(keyHandle: bigint): bigint {
		return this.insert(Uint8Array.from(this.material(keyHandle)));
	}

	destroyKeyHandle(keyHandle: bigint): boolean {
		const key = this.handles.get(keyHandle);
		if (key === undefined) {
			return false;
		}
		key.fill(0);
		this.handles.delete(keyHandle);
		return true;
	}

	generateEncryptionKey(): string {
		return toBase64(randomBytes(KEY_LENGTH));
	}

	// ------------------------------------------------------------------
	// Derivation
	// ------------------------------------------------------------------

	deriveKeysHandle(
		accountPassword: string,
		secretKey: string,
		email: string,
		schemaVersion: number,
		algorithm: string,
		iterations: number,
	): WasmDerivedKeyHandles {
		const masterKey = this.deriveMasterKeyHandle(
			accountPassword,
			secretKey,
			email,
			schemaVersion,
			algorithm,
			iterations,
		);
		try {
			return this.deriveKeysFromMasterKeyHandle(masterKey, email);
		} finally {
			this.destroyKeyHandle(masterKey);
		}
	}

	deriveMasterKeyHandle(
		accountPassword: string,
		secretKey: string,
		email: string,
		schemaVersion: number,
		algorithm: string,
		iterations: number,
	): bigint {
		return this.insert(
			expandBytes(
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
			),
		);
	}

	deriveKeysFromMasterKeyHandle(
		masterKeyHandle: bigint,
		email: string,
	): WasmDerivedKeyHandles {
		const seed = `${fingerprint(this.material(masterKeyHandle))}|${normalizeEmail(email)}`;
		return {
			auth_key_handle: this.insert(expandBytes(`auth|${seed}`, KEY_LENGTH)),
			master_unlock_key_handle: this.insert(
				expandBytes(`muk|${seed}`, KEY_LENGTH),
			),
		};
	}

	deriveSrpPasswordFromHandle(authKeyHandle: bigint): string {
		return lossyUtf8Decoder.decode(this.material(authKeyHandle));
	}

	// ------------------------------------------------------------------
	// Symmetric encryption
	// ------------------------------------------------------------------

	encryptWithHandle(plaintext: string, keyHandle: bigint): WasmEncryptedData {
		return seal(plaintext, this.material(keyHandle), aadOf(null));
	}

	encryptWithContextHandle(
		plaintext: string,
		keyHandle: bigint,
		context: WasmAadContext,
	): WasmEncryptedData {
		return seal(plaintext, this.material(keyHandle), aadOf(context));
	}

	decryptWithHandle(data: WasmEncryptedData, keyHandle: bigint): string {
		return open(data, this.material(keyHandle), aadOf(null));
	}

	decryptWithContextHandle(
		data: WasmEncryptedData,
		keyHandle: bigint,
		context: WasmAadContext,
	): string {
		return open(data, this.material(keyHandle), aadOf(context));
	}

	encryptKeyHandleWithKey(
		keyHandle: bigint,
		wrappingKeyBase64: string,
	): WasmEncryptedData {
		return seal(
			toBase64(this.material(keyHandle)),
			fromBase64(wrappingKeyBase64),
			aadOf(null),
		);
	}

	decryptKeyHandleWithKey(
		data: WasmEncryptedData,
		wrappingKeyBase64: string,
	): bigint {
		return this.insert(
			fromBase64(open(data, fromBase64(wrappingKeyBase64), aadOf(null))),
		);
	}

	// ------------------------------------------------------------------
	// RSA
	// ------------------------------------------------------------------

	generateRSAKeyPair(): WasmRsaKeyPair {
		const id = randomHex(16);
		return {
			public_key: pem("PUBLIC KEY", `fake-rsa-public:${id}`),
			private_key: pem("PRIVATE KEY", `fake-rsa-private:${id}`),
		};
	}

	rsaEncrypt(plaintext: string, publicKeyPem: string): string {
		const id = keyPairIdFrom(publicKeyPem, "public");
		return toBase64(utf8Encoder.encode(JSON.stringify({ id, p: plaintext })));
	}

	rsaDecrypt(ciphertext: string, privateKeyPem: string): string {
		const id = keyPairIdFrom(privateKeyPem, "private");
		let payload: { id?: unknown; p?: unknown };
		try {
			payload = JSON.parse(utf8Decoder.decode(fromBase64(ciphertext))) as {
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

	// ------------------------------------------------------------------
	// Vault keys and rotation
	// ------------------------------------------------------------------

	encryptVaultKeyForMember(
		vaultKeyBase64: string,
		memberPublicKey: string,
	): string {
		return this.rsaEncrypt(vaultKeyBase64, memberPublicKey);
	}

	encryptVaultKeyWithMUK(
		vaultKeyBase64: string,
		masterUnlockKeyBase64: string,
		vaultId: string,
		userId: string,
		keyVersion: bigint,
	): string {
		return this.wrapWithMuk(
			fromBase64(vaultKeyBase64),
			fromBase64(masterUnlockKeyBase64),
			vaultId,
			userId,
			keyVersion,
		);
	}

	reEncryptItem(
		item: WasmItemData,
		oldVaultKeyBase64: string,
		newVaultKeyBase64: string,
	): WasmReEncryptedItem {
		return this.rotateItem(
			item,
			fromBase64(oldVaultKeyBase64),
			fromBase64(newVaultKeyBase64),
		);
	}

	performKeyRotation(
		oldVaultKeyBase64: string,
		membersJson: string,
		itemsJson: string,
		vaultId: string,
		keyVersion: bigint,
		currentUserId: string,
		masterUnlockKeyBase64: string,
	): WasmKeyRotationResult {
		const oldKey = fromBase64(oldVaultKeyBase64);
		const muk = fromBase64(masterUnlockKeyBase64);
		const newKey = randomBytes(KEY_LENGTH);

		const members = JSON.parse(membersJson) as Array<{
			user_id: string;
			public_key: string;
		}>;
		const items = JSON.parse(itemsJson) as Array<{
			id: string;
			encrypted_data: string;
			encryption_iv: string;
			encryption_algorithm: string;
		}>;

		const memberEncryptedKeys = members.map((member) => ({
			user_id: member.user_id,
			encrypted_vault_key:
				member.user_id === currentUserId
					? this.wrapWithMuk(newKey, muk, vaultId, currentUserId, keyVersion)
					: this.rsaEncrypt(toBase64(newKey), member.public_key),
		}));
		const reEncryptedItems = items.map((item) =>
			this.rotateItem(
				new ItemDataDouble(
					item.id,
					item.encrypted_data,
					item.encryption_iv,
					item.encryption_algorithm,
				),
				oldKey,
				newKey,
			),
		);

		newKey.fill(0);
		return {
			getMemberEncryptedKeys: () => memberEncryptedKeys,
			getReEncryptedItems: () => reEncryptedItems,
		};
	}

	validateRotationData(membersJson: string): WasmValidationResult {
		const members = JSON.parse(membersJson) as Array<{
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
		return { valid: errors.length === 0, getErrors: () => errors };
	}

	// ------------------------------------------------------------------
	// Secret Key and Recovery Key
	// ------------------------------------------------------------------

	generateSecretKey(): string {
		return generateFormattedKey(SECRET_KEY_PREFIX, SECRET_KEY_SEGMENTS);
	}

	validateSecretKey(secretKey: string): boolean {
		return isFormattedKey(secretKey, SECRET_KEY_PREFIX, SECRET_KEY_SEGMENTS);
	}

	generateRecoveryKey(): string {
		return generateFormattedKey(RECOVERY_KEY_PREFIX, RECOVERY_KEY_SEGMENTS);
	}

	validateRecoveryKey(recoveryKey: string): boolean {
		return isFormattedKey(
			recoveryKey,
			RECOVERY_KEY_PREFIX,
			RECOVERY_KEY_SEGMENTS,
		);
	}

	encryptMasterKey(
		masterKeyBase64: string,
		recoveryKey: string,
		email: string,
	): WasmEncryptedData {
		return seal(
			masterKeyBase64,
			this.recoveryKeyBytes(recoveryKey, email),
			aadOf(null),
		);
	}

	decryptMasterKey(
		data: WasmEncryptedData,
		recoveryKey: string,
		email: string,
	): string {
		return open(data, this.recoveryKeyBytes(recoveryKey, email), aadOf(null));
	}

	// ------------------------------------------------------------------
	// Passkey / WebAuthn
	// ------------------------------------------------------------------

	generatePasskeyKeypair(): WasmPasskeyKeypair {
		const privateKey = randomBytes(KEY_LENGTH);
		return {
			private_key: toBase64(privateKey),
			public_key_cose: toBase64(
				expandBytes(`cose|${fingerprint(privateKey)}`, KEY_LENGTH),
			),
		};
	}

	generatePasskeyCredentialId(): string {
		return toBase64(randomBytes(KEY_LENGTH));
	}

	buildPasskeyAttestationObject(
		rpId: string,
		credentialIdBase64: string,
		cosePublicKeyBase64: string,
		signCount: number,
	): WasmPasskeyAttestation {
		const authenticatorData = Uint8Array.from([
			...expandBytes(`rp|${rpId}`, KEY_LENGTH),
			0x45,
			...expandBytes(`count|${signCount}`, 4),
			...fromBase64(credentialIdBase64),
			...fromBase64(cosePublicKeyBase64),
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

	signPasskeyAssertion(
		privateKeyBase64: string,
		rpId: string,
		clientDataHashBase64: string,
		signCount: number,
	): WasmPasskeyAssertion {
		// Rejects a malformed key the way `passkey.rs` does, before signing anything.
		fromBase64(privateKeyBase64);
		const authenticatorData = Uint8Array.from([
			...expandBytes(`rp|${rpId}`, KEY_LENGTH),
			0x05,
			...expandBytes(`count|${signCount}`, 4),
		]);
		return {
			authenticator_data: toBase64(authenticatorData),
			signature_der: toBase64(
				expandBytes(
					`sig|${privateKeyBase64}|${toBase64(authenticatorData)}|${clientDataHashBase64}`,
					64,
				),
			),
		};
	}

	// ------------------------------------------------------------------
	// Identifiers
	// ------------------------------------------------------------------

	generateUuid(): string {
		if (this.nextUuidFailure !== null) {
			const failure = this.nextUuidFailure;
			this.nextUuidFailure = null;
			throw failure;
		}
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

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private insert(key: Uint8Array): bigint {
		const handle = this.nextHandle;
		this.nextHandle += 1n;
		this.handles.set(handle, key);
		return handle;
	}

	private material(keyHandle: bigint): Uint8Array {
		const key = this.handles.get(keyHandle);
		if (key === undefined) {
			throw new Error("Invalid or expired key handle");
		}
		return key;
	}

	private recoveryKeyBytes(recoveryKey: string, email: string): Uint8Array {
		if (!this.validateRecoveryKey(recoveryKey)) {
			throw new Error("Invalid input: Invalid recovery key format");
		}
		return expandBytes(
			`recovery|${recoveryKey}|${normalizeEmail(email)}`,
			KEY_LENGTH,
		);
	}

	private wrapWithMuk(
		vaultKey: Uint8Array,
		masterUnlockKey: Uint8Array,
		vaultId: string,
		userId: string,
		keyVersion: bigint,
	): string {
		const encrypted = seal(
			toBase64(vaultKey),
			masterUnlockKey,
			aadOf(
				new AadContextDouble(
					vaultId,
					VAULT_KEY_WRAP_PURPOSE,
					"vault_key",
					keyVersion,
					userId,
				),
			),
		);
		return JSON.stringify({
			...encrypted,
			context: {
				vaultId,
				userId,
				keyVersion: Number(keyVersion),
				purpose: VAULT_KEY_WRAP_PURPOSE,
			},
		});
	}

	private rotateItem(
		item: WasmItemData,
		oldKey: Uint8Array,
		newKey: Uint8Array,
	): WasmReEncryptedItem {
		const plaintext = open(
			new EncryptedDataDouble(
				item.encrypted_data,
				item.encryption_iv,
				item.encryption_algorithm,
			),
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
}

// ============================================================================
// The Worker global, in memory
// ============================================================================

/**
 * A `Worker`, in process, running the real `serveCryptoPort` on the other side.
 *
 * Delivery is asynchronous in both directions and every payload goes through
 * `structuredClone`, so a value the adapter failed to encode fails here exactly as it
 * would in a browser.
 *
 * `holdReplies` freezes the return path so a test can prove that answers are matched to
 * calls by id rather than by arrival order: issue several calls, let the worker finish
 * them, then release the answers backwards.
 */
export class WorkerDouble implements CryptoWorkerHandle {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;

	/** Every call posted to the worker, in order. */
	readonly calls: CryptoPortCall[] = [];
	/** Every answer the worker produced, in the order it produced them. */
	readonly replies: CryptoPortReply[] = [];

	/** While true, answers accumulate instead of being delivered. */
	holdReplies = false;

	private readonly held: CryptoPortReply[] = [];
	private listener: ((event: { data: unknown }) => void) | null = null;

	constructor(loadWasm: LoadCryptoWasm) {
		const scope: CryptoWorkerScope = {
			addEventListener: (_type, listener) => {
				this.listener = listener;
			},
			postMessage: (message) => {
				this.answer(structuredClone(message) as CryptoPortReply);
			},
		};
		serveCryptoPort(scope, loadWasm);
	}

	postMessage(message: unknown): void {
		const call = structuredClone(message) as CryptoPortCall;
		this.calls.push(call);
		const listener = this.listener;
		queueMicrotask(() => {
			listener?.({ data: call });
		});
	}

	/** Deliver everything held back, oldest first or newest first. */
	releaseHeldReplies(order: "as-received" | "reverse" = "as-received"): void {
		this.holdReplies = false;
		const released =
			order === "reverse" ? [...this.held].reverse() : [...this.held];
		this.held.length = 0;
		for (const reply of released) {
			this.deliver(reply);
		}
	}

	/** Whatever kills a worker thread: an uncaught error, a failed module load. */
	fail(message: string): void {
		this.onerror?.(new ErrorEvent("error", { message }));
	}

	/** Calls to `method`, in order. */
	callsTo(method: string): CryptoPortCall[] {
		return this.calls.filter((call) => call.method === method);
	}

	private answer(reply: CryptoPortReply): void {
		this.replies.push(reply);
		if (this.holdReplies) {
			this.held.push(reply);
			return;
		}
		this.deliver(reply);
	}

	private deliver(reply: CryptoPortReply): void {
		this.onmessage?.(new MessageEvent("message", { data: reply }));
	}
}

// ============================================================================
// Wiring them into WasmWorkerDeps
// ============================================================================

export interface WasmWorkerDoubles {
	/** Pass this to `createWasmWorkerCryptoPort`. */
	deps: WasmWorkerDeps;
	wasm: CryptoWasmDouble;
	worker: WorkerDouble;
	/** How many times the adapter asked for a worker. Should never exceed one. */
	readonly workersCreated: number;
	/** How many times the worker loaded the WASM module. Should never exceed one. */
	readonly wasmLoads: number;
}

export interface WasmWorkerDoublesOptions {
	/** Simulate a WASM module that will not instantiate. */
	wasmFailure?: unknown;
}

/** A fresh, empty set of doubles plus the `WasmWorkerDeps` that hand them out. */
export function createWasmWorkerDoubles(
	options: WasmWorkerDoublesOptions = {},
): WasmWorkerDoubles {
	const wasm = new CryptoWasmDouble();
	let wasmLoads = 0;
	let workersCreated = 0;

	const worker = new WorkerDouble(async () => {
		wasmLoads += 1;
		if (options.wasmFailure !== undefined) {
			throw options.wasmFailure;
		}
		return wasm;
	});

	return {
		deps: {
			createWorker: () => {
				workersCreated += 1;
				return worker;
			},
		},
		wasm,
		worker,
		get workersCreated() {
			return workersCreated;
		},
		get wasmLoads() {
			return wasmLoads;
		},
	};
}
