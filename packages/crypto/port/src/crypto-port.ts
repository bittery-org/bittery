/**
 * The crypto seam.
 *
 * `CryptoPort` is dumb, total and all-async: ZERO optional members, one spelling per
 * concept, every member returning a `Promise`. The compiler therefore verifies that an
 * adapter satisfies the contract, and no caller ever feature-detects
 * (`typeof crypto.deriveKeyHandles === "function"` is what this design deletes).
 *
 * An adapter is pure marshalling onto one backend — argument order, base64 boundaries,
 * `KeyRef` bookkeeping, error translation. It makes no decisions. All policy lives above
 * this seam in `VaultCrypto`: the wrapped-vault-key envelope, wrap contexts, KDF pinning,
 * the legacy "decrypt without AAD then unwrap" fallback, and the seven account ceremonies.
 * The algorithms live below it, in the one Rust core (ADR 0001).
 *
 * Behavioural rules every adapter must obey:
 *   - A `KeyRef` this port did not mint, or one it minted and destroyed, THROWS
 *     (`invalid-key-ref` / `key-destroyed`). It never resolves to `null` or a zero key.
 *   - `destroyKey` zeroizes and is idempotent — destroying twice is a no-op, not a throw.
 *   - Every rejection is a `CryptoPortError` with a code from the closed set.
 *   - Nothing here reads or writes storage, and nothing here talks to a server.
 */

import type {
	EncryptedData,
	EncryptionContext,
	ItemData,
	KdfProfile,
	KeyRotationResult,
	MemberKeyData,
	ReEncryptedItem,
	RsaKeyPair,
	SRPClientEphemeral,
	SRPClientSession,
	SRPRegistration,
	SRPServerChallenge,
	ValidationResult,
} from "@bittery/types";

declare const KEY_REF_BRAND: unique symbol;

/**
 * An opaque handle to symmetric key material held by the backend.
 *
 * A `KeyRef` is the normal currency across the crypto seam: an identity token with no
 * readable members whose backing material belongs to the adapter. Web keeps its handles and
 * bytes inside the worker; desktop, mobile and the extension box a `Uint8Array` that
 * `destroyKey` zeroizes. `exportKey` is the explicit, total escape hatch when a platform
 * integration cannot consume a ref.
 *
 * A `KeyRef` belongs to the port that minted it and is meaningless anywhere else — it is not
 * serialisable, and it must not be persisted, structured-cloned or sent across a thread.
 * Adapters mint and read them with `createKeyRefTable` from `@bittery/crypto-port/key-ref`.
 */
export interface KeyRef {
	readonly [KEY_REF_BRAND]: true;
}

/** The two keys a login derivation produces. Both are live refs the caller must destroy. */
export interface DerivedKeyRefs {
	authKey: KeyRef;
	masterUnlockKey: KeyRef;
}

/**
 * One item in a `decryptMany` batch. `id` is echoed back so a caller can correlate results
 * without relying on position, and each request carries its own key so a mixed-vault item
 * list still costs one round trip.
 */
export interface DecryptRequest {
	id: string;
	data: EncryptedData;
	key: KeyRef;
	context: EncryptionContext | null;
}

/**
 * A per-item outcome. One undecryptable item must not fail a whole vault load, so a
 * ciphertext failure is reported rather than thrown — an invalid `KeyRef` still throws,
 * because that is a caller bug and not data.
 */
export type DecryptManyResult =
	| { id: string; ok: true; plaintext: string }
	| { id: string; ok: false; error: string };

/** Base64, because these are persisted and re-sent verbatim rather than fed to WebAuthn. */
export interface PasskeyKeypair {
	privateKey: string;
	publicKeyCose: string;
}

/** Bytes, because these go straight into a `PublicKeyCredential` response. */
export interface PasskeyAttestation {
	authenticatorData: Uint8Array;
	attestationObject: Uint8Array;
}

export interface PasskeyAssertion {
	authenticatorData: Uint8Array;
	signatureDer: Uint8Array;
}

export interface CryptoPort {
	/** Load the backend. Idempotent; every other member may assume it has run. */
	initialize(): Promise<void>;

	// ------------------------------------------------------------------
	// Key lifecycle
	// ------------------------------------------------------------------

	/** A fresh random 256-bit key — vault keys and device keys. */
	generateEncryptionKey(): Promise<KeyRef>;

	importKey(key: Uint8Array): Promise<KeyRef>;

	/**
	 * Returns a copy of the bytes behind any live ref. This exists because a platform must
	 * persist its root device key, which nothing else can wrap; the type cannot restrict it to
	 * that key. Production web never exports a MUK, while Android's audited credential-provider
	 * bridge does because its separate process accepts only base64 key material.
	 */
	exportKey(key: KeyRef): Promise<Uint8Array>;

	/** An independent ref over the same material: destroying one leaves the other live. */
	cloneKey(key: KeyRef): Promise<KeyRef>;

	/** Zeroizes the backing material. Idempotent; every later use of `key` throws. */
	destroyKey(key: KeyRef): Promise<void>;

	// ------------------------------------------------------------------
	// Derivation
	// ------------------------------------------------------------------

	deriveKeys(
		accountPassword: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<DerivedKeyRefs>;

	/** The PBKDF2 half of `deriveKeys`, split out because recovery re-enters at the HKDF step. */
	deriveMasterKey(
		accountPassword: string,
		secretKey: string,
		email: string,
		profile: KdfProfile,
	): Promise<KeyRef>;

	deriveKeysFromMasterKey(
		masterKey: KeyRef,
		email: string,
	): Promise<DerivedKeyRefs>;

	/** The auth key rendered as the string the SRP client takes as its password. */
	deriveSrpPassword(authKey: KeyRef): Promise<string>;

	// ------------------------------------------------------------------
	// Symmetric encryption
	// ------------------------------------------------------------------

	/**
	 * `context` is the AAD bound into the ciphertext, and it is required-but-nullable rather
	 * than optional so that "no context" is a decision the caller states.
	 */
	encrypt(
		plaintext: string,
		key: KeyRef,
		context: EncryptionContext | null,
	): Promise<EncryptedData>;

	/** Throws on a wrong key, a mismatched `context` or tampered input — all three alike. */
	decrypt(
		data: EncryptedData,
		key: KeyRef,
		context: EncryptionContext | null,
	): Promise<string>;

	/**
	 * One round trip for a whole item list. Results come back in request order; a per-item
	 * failure is reported in place instead of rejecting the batch.
	 */
	decryptMany(
		requests: readonly DecryptRequest[],
	): Promise<readonly DecryptManyResult[]>;

	/** Wrap `key` under `wrappingKey` so it can be persisted. */
	wrapKey(key: KeyRef, wrappingKey: KeyRef): Promise<EncryptedData>;

	/** Restore a wrapped key as a fresh ref with its own lifetime. */
	unwrapKey(data: EncryptedData, wrappingKey: KeyRef): Promise<KeyRef>;

	// ------------------------------------------------------------------
	// RSA
	// ------------------------------------------------------------------

	/**
	 * RSA keys are PEM strings, not `KeyRef`s: the private key is itself stored encrypted
	 * under the master unlock key and travels as text, and no backend has an RSA key table.
	 */
	generateRsaKeyPair(): Promise<RsaKeyPair>;

	rsaEncrypt(plaintext: string, publicKeyPem: string): Promise<string>;

	rsaDecrypt(ciphertext: string, privateKeyPem: string): Promise<string>;

	// ------------------------------------------------------------------
	// Vault keys and rotation
	// ------------------------------------------------------------------

	/** RSA-wraps a vault key for another member. Returns base64 ciphertext. */
	encryptVaultKeyForMember(
		vaultKey: KeyRef,
		memberPublicKeyPem: string,
	): Promise<string>;

	/**
	 * AES-wraps a vault key for its owner. The returned JSON envelope — ciphertext plus the
	 * wrap context — is produced by the core and is opaque here; `VaultCrypto` decides when
	 * to write it, never what it contains.
	 */
	encryptVaultKeyWithMuk(
		vaultKey: KeyRef,
		masterUnlockKey: KeyRef,
		vaultId: string,
		userId: string,
		keyVersion: number,
	): Promise<string>;

	reEncryptItem(
		item: ItemData,
		oldVaultKey: KeyRef,
		newVaultKey: KeyRef,
	): Promise<ReEncryptedItem>;

	/**
	 * A whole rotation in one backend call: the new vault key is generated, wrapped and
	 * discarded below the seam, so it never reaches JS on any platform.
	 */
	performKeyRotation(
		oldVaultKey: KeyRef,
		members: readonly MemberKeyData[],
		items: readonly ItemData[],
		vaultId: string,
		keyVersion: number,
		currentUserId: string,
		masterUnlockKey: KeyRef,
	): Promise<KeyRotationResult>;

	validateRotationData(
		members: readonly MemberKeyData[],
	): Promise<ValidationResult>;

	// ------------------------------------------------------------------
	// Secret Key
	// ------------------------------------------------------------------

	generateSecretKey(): Promise<string>;

	/** Format check only — a well-formed key that is simply wrong still validates. */
	validateSecretKey(secretKey: string): Promise<boolean>;

	// ------------------------------------------------------------------
	// Recovery
	// ------------------------------------------------------------------

	generateRecoveryKey(): Promise<string>;

	validateRecoveryKey(recoveryKey: string): Promise<boolean>;

	encryptMasterKey(
		masterKey: KeyRef,
		recoveryKey: string,
		email: string,
	): Promise<EncryptedData>;

	decryptMasterKey(
		data: EncryptedData,
		recoveryKey: string,
		email: string,
	): Promise<KeyRef>;

	// ------------------------------------------------------------------
	// SRP-6a client
	// ------------------------------------------------------------------

	generateSrpRegistration(password: string): Promise<SRPRegistration>;

	generateClientEphemeral(): Promise<SRPClientEphemeral>;

	deriveClientSession(
		clientEphemeralSecret: string,
		challenge: SRPServerChallenge,
		password: string,
	): Promise<SRPClientSession>;

	/** Resolves when the server proved itself; throws otherwise. There is no boolean. */
	verifyServerSession(
		clientPublicEphemeral: string,
		session: SRPClientSession,
		serverSessionProof: string,
	): Promise<void>;

	// ------------------------------------------------------------------
	// Passkey / WebAuthn
	// ------------------------------------------------------------------

	generatePasskeyKeypair(): Promise<PasskeyKeypair>;

	generatePasskeyCredentialId(): Promise<string>;

	/** `signCount` is required here; the backends' `Option<u32>` default is not a port concept. */
	buildPasskeyAttestationObject(
		rpId: string,
		credentialIdBase64: string,
		cosePublicKeyBase64: string,
		signCount: number,
	): Promise<PasskeyAttestation>;

	signPasskeyAssertion(
		privateKeyBase64: string,
		rpId: string,
		clientDataHashBase64: string,
		signCount: number,
	): Promise<PasskeyAssertion>;

	// ------------------------------------------------------------------
	// Identifiers
	// ------------------------------------------------------------------

	/** RFC 4122 v4, from the backend's CSPRNG rather than the ambient one. */
	generateUuid(): Promise<string>;
}
