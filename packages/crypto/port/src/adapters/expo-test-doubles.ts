/**
 * An in-process double for `@bittery/crypto-nitro`, the one thing this adapter loads.
 *
 * `bun test` has no React Native runtime: `expo-modules-core` cannot even be parsed there, let
 * alone reach a real iOS/Android build. The adapter reaches the module through its `ExpoDeps`
 * seam, so a test supplies this instead — the **real** adapter code runs against it, only the
 * native module is faked.
 *
 * Unlike the wasm doubles, there is no key-handle store to reproduce here: every method in
 * `@bittery/crypto-nitro` is stateless with respect to key material, taking it as a plain
 * base64 argument, exactly like `TauriCryptoDouble`. This double is a near-duplicate of that
 * one's toy cipher, RSA and derivation logic — the same underlying `bittery-crypto-core`
 * algorithms, re-derived here rather than imported, matching the convention `tauri-test-
 * doubles.ts` itself set (its own `expandBytes` is a redraw of `wasm-worker-test-doubles.ts`'s,
 * not a shared import): "the pattern worth copying is the shape, not the file contents."
 *
 * **The cipher below is a toy and protects nothing** — a keyed XOR mask over a JSON payload
 * carrying a key fingerprint and the AAD. What is real is the vocabulary: every thrown message
 * is either the literal `Display` string of `bittery_crypto_core::CryptoError` or the FFI's own
 * pre-decode guard text ("Invalid key base64: …"), because those are exactly the strings
 * `classify` in `expo.ts` reads.
 *
 * Nothing here is exported to production code.
 */

import type {
	DerivedKeys,
	EncryptedData,
	ItemData,
	KdfProfile,
	KeyRotationResult,
	MemberKeyData,
	ReEncryptedItem,
	RsaKeyPair,
	SRPClientSession,
	ValidationResult,
} from "@bittery/types";
import type { ExpoCryptoModule, ExpoDeps } from "./expo";

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

/** The FFI's own core-level decode failure — `Base64Decode`'s Display, verbatim. */
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

/** The FFI's own pre-decode guard for a top-level `*_base64` argument. */
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
 * The index goes in front of the seed, not after — S5's collision fix. FNV-1a's low byte
 * otherwise depends only on the low byte of the state before it, so the whole expansion would
 * take just 256 distinct values however long it is.
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

function seal(plaintext: string, key: Uint8Array, aad: string): EncryptedData {
	const iv = randomBytes(12);
	const payload = JSON.stringify({ p: plaintext, a: aad, k: fingerprint(key) });
	return {
		ciphertext: toBase64(mask(utf8Encoder.encode(payload), key, iv)),
		iv: toBase64(iv),
		algorithm: ALGORITHM,
	};
}

function open(data: EncryptedData, key: Uint8Array, aad: string): string {
	if (data.algorithm !== ALGORITHM) {
		throw new Error(
			`Decryption failed: unsupported algorithm ${data.algorithm}`,
		);
	}
	// The core decodes ciphertext/iv *before* touching the AEAD, so malformed base64 surfaces
	// as `Base64Decode`'s own message rather than being folded into a decryption failure.
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

function rsaEncryptBase64(plaintext: string, publicKeyPem: string): string {
	const id = keyPairIdFrom(publicKeyPem, "public");
	return toBase64(utf8Encoder.encode(JSON.stringify({ id, p: plaintext })));
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
): DerivedKeys {
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
	item: ItemData,
	oldKey: Uint8Array,
	newKey: Uint8Array,
): ReEncryptedItem {
	const plaintext = open(
		{
			ciphertext: item.encryptedData,
			iv: item.encryptionIv,
			algorithm: item.encryptionAlgorithm,
		},
		oldKey,
		aadOf(null),
	);
	const resealed = seal(plaintext, newKey, aadOf(null));
	return {
		itemId: item.id,
		encryptedData: resealed.ciphertext,
		encryptionIv: resealed.iv,
	};
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
// The SRP client double — one per `createSRPClient` call, matching the native side's
// one-allocation-per-instance shape closely enough to prove the adapter never re-creates one
// mid-ceremony.
// ============================================================================

class ExpoSrpClientDouble {
	async deriveSafePrivateKey(salt: string, password: string): Promise<string> {
		return expandHex(`private|${salt}|${password}`, 32);
	}

	generateSalt(): string {
		return randomHex(16);
	}

	deriveVerifier(privateKey: string): string {
		return expandHex(`verifier|${privateKey}`, 32);
	}

	generateEphemeral(): { public: string; secret: string } {
		return { public: randomHex(32), secret: randomHex(32) };
	}

	async deriveSession(
		clientSecretEphemeral: string,
		serverPublicEphemeral: string,
		salt: string,
		username: string,
		privateKey: string,
	): Promise<SRPClientSession> {
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

	async verifySession(
		clientPublicEphemeral: string,
		session: SRPClientSession,
		serverSessionProof: string,
	): Promise<void> {
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
// The double
// ============================================================================

/**
 * `@bittery/crypto-nitro`, in memory.
 *
 * Stateless with respect to key material, exactly like the real module: nothing here
 * remembers a key between calls, so there is no handle table to leak or to assert against —
 * only the values each call is given. `calls` is a bare method-name log (unlike Tauri's
 * `{cmd, args}` — every argument here is already a typed parameter, not a string-keyed bag),
 * enough to prove which native methods an adapter member actually reaches.
 */
export class ExpoCryptoModuleDouble implements ExpoCryptoModule {
	readonly calls: string[] = [];
	/** When set, the next call to any method throws it instead of answering. */
	nextFailure: unknown = null;
	/** How many `createSRPClient` calls this double has served. */
	srpClientsCreated = 0;

	private record(method: string): void {
		this.calls.push(method);
		if (this.nextFailure !== null) {
			const failure = this.nextFailure;
			this.nextFailure = null;
			throw failure;
		}
	}

	/** Calls to `method`, in order. */
	callsTo(method: string): string[] {
		return this.calls.filter((call) => call === method);
	}

	async deriveKeys(
		password: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<DerivedKeys> {
		this.record("deriveKeys");
		const masterKey = deriveMasterKeyBytes(
			password,
			secretKey,
			email,
			profile.schemaVersion,
			profile.algorithm,
			profile.iterations,
		);
		return deriveKeysFromMasterKeyBytes(masterKey, email);
	}

	async deriveMasterKey(
		accountPassword: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<string> {
		this.record("deriveMasterKey");
		return toBase64(
			deriveMasterKeyBytes(
				accountPassword,
				secretKey,
				email,
				profile.schemaVersion,
				profile.algorithm,
				profile.iterations,
			),
		);
	}

	async deriveKeysFromMasterKey(
		masterKeyBase64: string,
		email: string,
	): Promise<DerivedKeys> {
		this.record("deriveKeysFromMasterKey");
		const masterKey = fromBase64Arg(masterKeyBase64, "master key");
		return deriveKeysFromMasterKeyBytes(masterKey, email);
	}

	async encrypt(plaintext: string, keyBase64: string): Promise<EncryptedData> {
		this.record("encrypt");
		const key = fromBase64Arg(keyBase64, "key");
		return seal(plaintext, key, aadOf(null));
	}

	async encryptWithContext(
		plaintext: string,
		keyBase64: string,
		vaultId: string,
		entityId: string,
		entityType: string,
		version: number,
		userId: string,
	): Promise<EncryptedData> {
		this.record("encryptWithContext");
		const key = fromBase64Arg(keyBase64, "key");
		return seal(
			plaintext,
			key,
			aadOf({ vaultId, entityId, entityType, version, userId }),
		);
	}

	async decrypt(
		ciphertext: string,
		iv: string,
		algorithm: string,
		keyBase64: string,
	): Promise<string> {
		this.record("decrypt");
		const key = fromBase64Arg(keyBase64, "key");
		return open({ ciphertext, iv, algorithm }, key, aadOf(null));
	}

	async decryptWithContext(
		ciphertext: string,
		iv: string,
		algorithm: string,
		keyBase64: string,
		vaultId: string,
		entityId: string,
		entityType: string,
		version: number,
		userId: string,
	): Promise<string> {
		this.record("decryptWithContext");
		const key = fromBase64Arg(keyBase64, "key");
		return open(
			{ ciphertext, iv, algorithm },
			key,
			aadOf({ vaultId, entityId, entityType, version, userId }),
		);
	}

	generateEncryptionKey(): string {
		this.record("generateEncryptionKey");
		return toBase64(randomBytes(KEY_LENGTH));
	}

	generateUuid(): string {
		this.record("generateUuid");
		return generateUuidV4();
	}

	async generateRsaKeyPair(): Promise<RsaKeyPair> {
		this.record("generateRsaKeyPair");
		const id = randomHex(16);
		return {
			publicKey: pem("PUBLIC KEY", `fake-rsa-public:${id}`),
			privateKey: pem("PRIVATE KEY", `fake-rsa-private:${id}`),
		};
	}

	async rsaEncrypt(plaintext: string, publicKeyPem: string): Promise<string> {
		this.record("rsaEncrypt");
		return rsaEncryptBase64(plaintext, publicKeyPem);
	}

	async rsaDecrypt(ciphertext: string, privateKeyPem: string): Promise<string> {
		this.record("rsaDecrypt");
		const id = keyPairIdFrom(privateKeyPem, "private");
		// `rsa_decrypt` (core) decodes the ciphertext itself, before ever touching the
		// private key — a malformed argument is a bare "Base64 decode error: …", not wrapped
		// as "RSA operation failed: …" the way an OAEP failure is.
		const ciphertextBytes = fromBase64(ciphertext);
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

	generateSecretKey(): string {
		this.record("generateSecretKey");
		return generateFormattedKey(SECRET_KEY_PREFIX, SECRET_KEY_SEGMENTS);
	}

	validateSecretKey(secretKey: string): boolean {
		this.record("validateSecretKey");
		return isFormattedKey(secretKey, SECRET_KEY_PREFIX, SECRET_KEY_SEGMENTS);
	}

	generateRecoveryKey(): string {
		this.record("generateRecoveryKey");
		return generateFormattedKey(RECOVERY_KEY_PREFIX, RECOVERY_KEY_SEGMENTS);
	}

	validateRecoveryKey(recoveryKey: string): boolean {
		this.record("validateRecoveryKey");
		return isFormattedKey(
			recoveryKey,
			RECOVERY_KEY_PREFIX,
			RECOVERY_KEY_SEGMENTS,
		);
	}

	async encryptMasterKey(
		masterKeyBase64: string,
		recoveryKey: string,
		email: string,
	): Promise<EncryptedData> {
		this.record("encryptMasterKey");
		const masterKey = fromBase64Arg(masterKeyBase64, "master key");
		if (masterKey.length !== KEY_LENGTH) {
			throw new Error(
				`Invalid key length: expected ${KEY_LENGTH}, got ${masterKey.length}`,
			);
		}
		const encryptionKey = recoveryKeyBytes(recoveryKey, email);
		return seal(toBase64(masterKey), encryptionKey, aadOf(null));
	}

	async decryptMasterKey(
		ciphertext: string,
		iv: string,
		algorithm: string,
		recoveryKey: string,
		email: string,
	): Promise<string> {
		this.record("decryptMasterKey");
		const encryptionKey = recoveryKeyBytes(recoveryKey, email);
		const decoded = open(
			{ ciphertext, iv, algorithm },
			encryptionKey,
			aadOf(null),
		);
		// `decrypt_master_key` (core) decodes the AES output itself, with no wrapper.
		const masterKey = fromBase64(decoded);
		if (masterKey.length !== KEY_LENGTH) {
			throw new Error(
				`Invalid key length: expected ${KEY_LENGTH}, got ${masterKey.length}`,
			);
		}
		return decoded;
	}

	createSRPClient(): ExpoSrpClientDouble {
		this.record("createSRPClient");
		this.srpClientsCreated += 1;
		return new ExpoSrpClientDouble();
	}

	async generatePasskeyKeypair(): Promise<{
		privateKey: string;
		publicKeyCose: string;
	}> {
		this.record("generatePasskeyKeypair");
		const privateKey = randomBytes(KEY_LENGTH);
		return {
			privateKey: toBase64(privateKey),
			publicKeyCose: toBase64(
				expandBytes(`cose|${fingerprint(privateKey)}`, KEY_LENGTH),
			),
		};
	}

	generatePasskeyCredentialId(): string {
		this.record("generatePasskeyCredentialId");
		return toBase64(randomBytes(KEY_LENGTH));
	}

	async buildPasskeyAttestationObject(
		rpId: string,
		credentialIdBase64: string,
		cosePublicKeyBase64: string,
		signCount: number,
	): Promise<{ authenticatorData: string; attestationObject: string }> {
		this.record("buildPasskeyAttestationObject");
		const credentialId = fromBase64Arg(credentialIdBase64, "credential id");
		const cosePublicKey = fromBase64Arg(cosePublicKeyBase64, "public key");
		const authenticatorData = Uint8Array.from([
			...expandBytes(`rp|${rpId}`, KEY_LENGTH),
			0x45,
			...expandBytes(`count|${signCount}`, 4),
			...credentialId,
			...cosePublicKey,
		]);
		return {
			authenticatorData: toBase64(authenticatorData),
			attestationObject: toBase64(
				utf8Encoder.encode(
					JSON.stringify({
						fmt: "none",
						authData: toBase64(authenticatorData),
					}),
				),
			),
		};
	}

	async signPasskeyAssertion(
		privateKeyBase64: string,
		rpId: string,
		clientDataHashBase64: string,
		signCount: number,
	): Promise<{ authenticatorData: string; signatureDer: string }> {
		this.record("signPasskeyAssertion");
		// Rejects a malformed key or client data hash the way the native side does — both
		// are decoded before signing anything is attempted.
		fromBase64Arg(privateKeyBase64, "private key");
		fromBase64Arg(clientDataHashBase64, "client data hash");
		const authenticatorData = Uint8Array.from([
			...expandBytes(`rp|${rpId}`, KEY_LENGTH),
			0x05,
			...expandBytes(`count|${signCount}`, 4),
		]);
		return {
			authenticatorData: toBase64(authenticatorData),
			signatureDer: toBase64(
				expandBytes(
					`sig|${privateKeyBase64}|${toBase64(authenticatorData)}|${clientDataHashBase64}`,
					64,
				),
			),
		};
	}

	async encryptVaultKeyForMember(
		vaultKeyBase64: string,
		memberPublicKeyPem: string,
	): Promise<string> {
		this.record("encryptVaultKeyForMember");
		const vaultKey = fromBase64Arg(vaultKeyBase64, "vault key");
		return rsaEncryptBase64(toBase64(vaultKey), memberPublicKeyPem);
	}

	async encryptVaultKeyWithMuk(
		vaultKeyBase64: string,
		masterUnlockKeyBase64: string,
		vaultId: string,
		userId: string,
		keyVersion: number,
	): Promise<string> {
		this.record("encryptVaultKeyWithMuk");
		const vaultKey = fromBase64Arg(vaultKeyBase64, "vault key");
		const muk = fromBase64Arg(masterUnlockKeyBase64, "MUK");
		return wrapWithMuk(vaultKey, muk, vaultId, userId, keyVersion);
	}

	async reEncryptItem(
		item: ItemData,
		oldVaultKeyBase64: string,
		newVaultKeyBase64: string,
	): Promise<ReEncryptedItem> {
		this.record("reEncryptItem");
		const oldKey = fromBase64Arg(oldVaultKeyBase64, "old key");
		const newKey = fromBase64Arg(newVaultKeyBase64, "new key");
		return rotateItem(item, oldKey, newKey);
	}

	async performKeyRotation(
		oldVaultKeyBase64: string,
		members: MemberKeyData[],
		items: ItemData[],
		vaultId: string,
		keyVersion: number,
		currentUserId: string,
		masterUnlockKeyBase64: string,
	): Promise<KeyRotationResult> {
		this.record("performKeyRotation");
		const oldKey = fromBase64Arg(oldVaultKeyBase64, "old key");
		const muk = fromBase64Arg(masterUnlockKeyBase64, "MUK");
		const newKey = randomBytes(KEY_LENGTH);

		const memberEncryptedKeys = members.map((member) => ({
			userId: member.userId,
			encryptedVaultKey:
				member.userId === currentUserId
					? wrapWithMuk(newKey, muk, vaultId, currentUserId, keyVersion)
					: rsaEncryptBase64(toBase64(newKey), member.publicKey),
		}));
		const reEncryptedItems = items.map((item) =>
			rotateItem(item, oldKey, newKey),
		);
		newKey.fill(0);
		return { memberEncryptedKeys, reEncryptedItems };
	}

	async validateRotationData(
		members: MemberKeyData[],
	): Promise<ValidationResult> {
		this.record("validateRotationData");
		const errors = members.flatMap((member) => {
			if (member.publicKey.length === 0) {
				return [`Member ${member.userId} has no public key`];
			}
			if (!member.publicKey.includes(PUBLIC_KEY_MARKER)) {
				return [`Member ${member.userId} has invalid public key format`];
			}
			return [];
		});
		return { valid: errors.length === 0, errors };
	}
}

// ============================================================================
// Wiring into ExpoDeps
// ============================================================================

export interface ExpoDoubles {
	/** Pass this to `createExpoCryptoPort`. */
	deps: ExpoDeps;
	backend: ExpoCryptoModuleDouble;
	/** How many times the adapter asked for the native module. Should never exceed one. */
	readonly moduleLoads: number;
}

export interface ExpoDoublesOptions {
	/** Simulate `@bittery/crypto-nitro` not being available (native module not linked). */
	moduleMissing?: boolean;
}

/** A fresh, empty double plus the `ExpoDeps` that hand it out. */
export function createExpoDoubles(
	options: ExpoDoublesOptions = {},
): ExpoDoubles {
	const backend = new ExpoCryptoModuleDouble();
	let moduleLoads = 0;

	return {
		deps: {
			loadModule: async () => {
				moduleLoads += 1;
				if (options.moduleMissing === true) {
					throw new Error("Cannot find native module 'BitteryCrypto'");
				}
				return backend;
			},
		},
		backend,
		get moduleLoads() {
			return moduleLoads;
		},
	};
}
