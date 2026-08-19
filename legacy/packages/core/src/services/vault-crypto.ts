/**
 * `VaultCrypto` — the deep module above `CryptoPort`.
 *
 * `CryptoPort` is dumb marshalling and the Rust core is the algorithms; everything in
 * between — which key opens which value, what gets bound into the AAD, what a wrapped vault
 * key looks like on the wire, which KDF profiles this client will accept — is policy, and it
 * lives here so that exactly one implementation of it exists. Before this module the four
 * platform adapters each carried a copy of the vault-key wrap context inside `encrypt()`,
 * so the envelope format was defined four times and enforced nowhere.
 *
 * ## `KeyRef` ownership
 *
 * A `KeyRef` has a lifetime that no type carries, so the rules are stated once, here:
 *
 * - Every `KeyRef` this module **returns** is fresh and belongs to the caller, who must
 *   `destroyKey` it. That includes every vault key: unwrapping mints a new ref each time,
 *   nothing is cached, and two calls for the same vault produce two independent refs.
 * - Every `KeyRef` this module **takes** stays the caller's. Nothing here destroys an
 *   argument.
 * - The master unlock key read from the store is the **store's**, borrowed for the length of
 *   one call and never destroyed here. `AccountStore.getMasterUnlockKey` hands back the ref
 *   it owns until the account locks, whereas `AccountStore.decryptStoredMasterUnlockKey`
 *   mints one the *caller* must destroy — this module only ever uses the former, so it can
 *   never destroy a key the store still believes it owns.
 */

import type {
	CryptoPort,
	DecryptManyResult,
	EncryptedData,
	EncryptionContext,
	KdfProfile,
	KeyRef,
} from "@bittery/crypto-port";
import { getRecoveryKeyHint, getSecretKeyHint } from "@bittery/shared/crypto";
import {
	currentKdfProfile,
	validateKdfProfileOrThrow,
} from "@bittery/shared/kdf-policy";
import type { VaultKeyEntry } from "@bittery/shared/vault-mapping";
import type { SessionExpiryInput } from "@bittery/storage/types";
import type { CachedEncryptedItem } from "@bittery/types";

// ============================================================================
// The encryption contexts (AAD)
// ============================================================================

/**
 * Every ciphertext in a vault is bound to the entity it belongs to, so a ciphertext moved
 * from one item, field or vault to another fails to decrypt instead of silently opening.
 * These builders are the only place that binding is spelled out.
 *
 * An item has two of them and they are deliberately not interchangeable:
 *
 * - **Writing** binds the revision the ciphertext is *about to become* — `existing.version + 1`,
 *   a number no record carries yet — so the writer states it. That is {@link ItemWriteScope}.
 * - **Reading** binds the revision the ciphertext was *sealed at*, which the stored record
 *   already carries. Readers therefore hand over the record ({@link StoredItemBinding}) and
 *   the fields are pulled from it, because a reader who retypes them can pair one item's
 *   ciphertext with another item's binding and lose that plaintext permanently.
 *
 * `encryptionVersion` is not `version`: a bump for optimistic concurrency leaves the
 * ciphertext alone, so the two drift apart as a matter of course.
 */

/** Where a *new* ciphertext will sit — the revision being written, not one already stored. */
export interface ItemWriteScope {
	vaultId: string;
	itemId: string;
	version: number;
	userId: string;
}

/**
 * The stored fields an item's AAD was bound to. Read paths pass the record itself, so the
 * compiler pulls these four rather than the programmer.
 */
export type StoredItemBinding = Pick<
	CachedEncryptedItem,
	"id" | "vaultId" | "encryptionVersion" | "encryptedByUserId"
>;

/** A stored item's ciphertext together with the binding it was sealed under. */
export type StoredItemCiphertext = StoredItemBinding &
	Pick<
		CachedEncryptedItem,
		"encryptedData" | "encryptionIv" | "encryptionAlgorithm"
	>;

interface AttachmentContextInput {
	vaultId: string;
	attachmentId: string;
	userId: string;
	envelopeVersion: number;
}

interface VaultKeyContextInput {
	vaultId: string;
	userId: string;
	keyVersion: number;
}

/** The `entityId` of a wrapped vault key, and the marker its wrap context must carry. */
export const VAULT_KEY_WRAP_PURPOSE = "vault-key-wrap";

function normalizeVersion(version: number): number {
	if (!Number.isFinite(version) || version < 1) {
		return 1;
	}
	return Math.floor(version);
}

/**
 * Not exported: `encryptItem` is the only way to bind a write context, so nobody can seal a
 * ciphertext against a context this module never saw.
 */
function buildItemEncryptionContext(scope: ItemWriteScope): EncryptionContext {
	return {
		vaultId: scope.vaultId,
		entityId: scope.itemId,
		entityType: "item",
		version: normalizeVersion(scope.version),
		userId: scope.userId,
	};
}

/** The stored ciphertext triple, read off the record beside the binding it belongs to. */
function storedItemData(item: StoredItemCiphertext): EncryptedData {
	return {
		ciphertext: item.encryptedData,
		iv: item.encryptionIv,
		algorithm: item.encryptionAlgorithm,
	};
}

/**
 * Rebuilds the context a stored item was sealed under, from the record itself. Exported for
 * key rotation, which re-encrypts under the binding each item already has.
 */
export function buildStoredItemEncryptionContext(
	item: StoredItemBinding,
): EncryptionContext {
	return buildItemEncryptionContext({
		vaultId: item.vaultId,
		itemId: item.id,
		version: item.encryptionVersion,
		userId: item.encryptedByUserId,
	});
}

export function buildAttachmentNameEncryptionContext(
	input: AttachmentContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.attachmentId,
		entityType: "attachment_name",
		// Key rotation rewraps only the Attachment-key envelope; payload AAD stays stable.
		version: 1,
		userId: input.userId,
	};
}

export function buildAttachmentContentTypeEncryptionContext(
	input: AttachmentContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.attachmentId,
		entityType: "attachment_content_type",
		version: 1,
		userId: input.userId,
	};
}

export function buildAttachmentBlobEncryptionContext(
	input: AttachmentContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.attachmentId,
		entityType: "attachment_blob",
		version: 1,
		userId: input.userId,
	};
}

export function buildAttachmentKeyEncryptionContext(
	input: AttachmentContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.attachmentId,
		entityType: "attachment_key",
		version: normalizeVersion(input.envelopeVersion),
		userId: input.userId,
	};
}

function buildVaultKeyEncryptionContext(
	input: VaultKeyContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: VAULT_KEY_WRAP_PURPOSE,
		entityType: "vault_key",
		version: input.keyVersion,
		userId: input.userId,
	};
}

// ============================================================================
// The wrapped vault key envelope
// ============================================================================

/**
 * The wire form of a vault key wrapped under its owner's master unlock key: an
 * `EncryptedData` plus the context the AAD was built from, so a reader can rebuild that
 * context before it has anything else to go on. The core writes this JSON
 * (`key_rotation.rs`); this module only reads it and asks the port to produce it.
 */
interface WrappedVaultKey {
	ciphertext: string;
	iv: string;
	algorithm: string;
	context: {
		vaultId: string;
		userId: string;
		keyVersion: number;
		purpose: string;
	};
}

/**
 * Whether this vault key is wrapped under the account's master unlock key (the owner's own
 * copy, a JSON envelope) rather than RSA-wrapped for a member (bare base64).
 */
export function isOwnerWrappedVaultKey(encryptedVaultKey: string): boolean {
	try {
		const parsed = JSON.parse(encryptedVaultKey) as {
			ciphertext?: unknown;
			iv?: unknown;
		};
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof parsed.ciphertext === "string" &&
			typeof parsed.iv === "string"
		);
	} catch {
		return false;
	}
}

// ============================================================================
// Public surface
// ============================================================================

/**
 * What `VaultCrypto` needs from the account store — a strict subset of `AccountStore`, so
 * that this module can be exercised without one and cannot reach for anything else.
 */
export interface VaultCryptoStore {
	getVaultKeys(
		accountId?: string,
	): Promise<Array<{ vaultId: string; encryptedVaultKey: string }> | null>;
	/** The store owns this ref: borrow it, never destroy it. */
	getMasterUnlockKey(accountId?: string): Promise<KeyRef | null>;
	getEncryptedPrivateKey(accountId?: string): Promise<string | null>;
	getStoredSessionData(accountId?: string): Promise<{ userId: string } | null>;
	getPinnedKdfProfile(accountId: string): Promise<KdfProfile | null>;
}

export interface VaultCryptoDeps {
	crypto: CryptoPort;
	storage: VaultCryptoStore;
}

export interface AttachmentScope {
	vaultId: string;
	attachmentId: string;
	userId: string;
	envelopeVersion: number;
}

export type AttachmentField = "name" | "contentType" | "blob";

export interface DecryptStoredItemRequest {
	item: StoredItemCiphertext;
	vaultKey: KeyRef;
}

export interface EncryptedAttachmentMetaInput {
	encryptedName: string;
	encryptedContentType: string;
	encryptionIv: string;
	encryptedContentTypeIv: string;
	encryptionAlgorithm: string;
}

export interface DeriveAccountKeysInput {
	accountPassword: string;
	secretKey: string;
	email: string;
	/** The server's login profile. Validated against local policy and the pin first. */
	profile: KdfProfile;
	/** Pins are per account; omit for a signup, which has no account to pin against yet. */
	accountId?: string;
	/**
	 * Supply the account's Recovery Key to also get the master key sealed under it. The
	 * master key itself never leaves this call.
	 */
	recoveryKey?: string;
}

export interface DerivedAccountKeys {
	/** The auth key rendered for SRP. The auth key ref itself is destroyed before returning. */
	srpPassword: string;
	/** Caller owns this and must destroy it. */
	masterUnlockKey: KeyRef;
	/** Present only when `recoveryKey` was supplied. */
	encryptedMasterKey: EncryptedData | null;
}

export interface UnwrapVaultKeyInput {
	encryptedVaultKey: string;
	/** Borrowed, not consumed. */
	masterUnlockKey: KeyRef;
	/** Needed only for an RSA-wrapped (shared) vault key. */
	encryptedPrivateKey?: string | null;
	/** When given, the wrap context must name this vault, or the key is refused. */
	expectedVaultId?: string;
	/** When given, the wrap context must name this user, or the key is refused. */
	expectedUserId?: string;
}

export interface WrapVaultKeyForOwnerInput {
	/** Borrowed, not consumed. */
	vaultKey: KeyRef;
	/** Borrowed, not consumed. */
	masterUnlockKey: KeyRef;
	vaultId: string;
	userId: string;
	keyVersion: number;
}

export interface StoredVaultKeyInput {
	encryptedVaultKey: string;
	vaultId?: string;
	userId?: string;
	accountId?: string;
}

export interface VaultCrypto {
	// --- account keys ---

	/**
	 * Runs the account KDF for a login, an unlock or a password change.
	 *
	 * The KDF profile is validated against local policy and the account's pin **before** any
	 * derivation runs, so a server that offers a weakened profile is refused rather than
	 * merely noticed. The auth key never escapes: it is rendered to the SRP password and
	 * destroyed here, and so is the master key once the recovery envelope is sealed.
	 */
	deriveAccountKeys(input: DeriveAccountKeysInput): Promise<DerivedAccountKeys>;

	/** Accepts the profile or throws. Pins are read from the store when `accountId` is given. */
	validateKdfProfile(
		profile: KdfProfile,
		accountId?: string,
	): Promise<KdfProfile>;

	// --- vault keys ---

	/** `null` when this account has no key for that vault; otherwise a fresh ref to destroy. */
	getVaultKey(input: {
		vaultId: string;
		userId?: string;
		accountId?: string;
	}): Promise<KeyRef | null>;

	/** As {@link getVaultKey}, for a wrapped key the caller already holds. */
	unwrapStoredVaultKey(input: StoredVaultKeyInput): Promise<KeyRef>;

	/** The store-free form: everything it needs is passed in. */
	unwrapVaultKey(input: UnwrapVaultKeyInput): Promise<KeyRef>;

	/**
	 * Wraps a vault key for its owner, returning the envelope to persist verbatim. This is
	 * the ONLY way to produce one: `CryptoPort.encrypt` binds a context into the AAD but
	 * writes nothing alongside the ciphertext, so a vault key encrypted through it directly
	 * would be unreadable.
	 */
	wrapVaultKeyForOwner(input: WrapVaultKeyForOwnerInput): Promise<string>;

	// --- item payloads ---

	/**
	 * Seals a new revision. The scope's `version` is the revision this ciphertext will be
	 * stored as, which is why it is stated rather than read off a record.
	 */
	encryptItem(
		plaintext: string,
		vaultKey: KeyRef,
		scope: ItemWriteScope,
	): Promise<EncryptedData>;

	/** Opens a stored item under the binding its own record carries. */
	decryptStoredItem(
		item: StoredItemCiphertext,
		vaultKey: KeyRef,
	): Promise<string>;

	/** One port round trip for the whole batch; results keep request order and item ids. */
	decryptStoredItems(
		requests: readonly DecryptStoredItemRequest[],
	): Promise<readonly DecryptManyResult[]>;

	encryptAttachment(
		plaintext: string,
		vaultKey: KeyRef,
		scope: AttachmentScope,
		field: AttachmentField,
	): Promise<EncryptedData>;

	decryptAttachment(
		data: EncryptedData,
		vaultKey: KeyRef,
		scope: AttachmentScope,
		field: AttachmentField,
	): Promise<string>;

	decryptAttachmentMeta(
		encrypted: EncryptedAttachmentMetaInput,
		vaultKey: KeyRef,
		scope: AttachmentScope,
	): Promise<{ name: string; contentType: string }>;

	/** Mints a fresh Attachment key; the caller owns it until it is retired. */
	generateAttachmentKey(): Promise<KeyRef>;

	/** Retires a caller-owned Attachment key. */
	destroyAttachmentKey(key: KeyRef): Promise<void>;

	/** Wraps an Attachment key under the Vault key without exposing either key's bytes. */
	wrapAttachmentKey(
		attachmentKey: KeyRef,
		vaultKey: KeyRef,
		scope: AttachmentScope,
	): Promise<EncryptedData>;

	/** Opens an authenticated Attachment-key envelope as a fresh ref owned by the caller. */
	unwrapAttachmentKey(
		encryptedAttachmentKey: EncryptedData,
		vaultKey: KeyRef,
		scope: AttachmentScope,
	): Promise<KeyRef>;

	// --- the account's RSA private key ---

	/** The PEM, decrypted under the master unlock key it was stored against. */
	decryptPrivateKey(
		encryptedPrivateKey: string,
		masterUnlockKey: KeyRef,
	): Promise<string>;
}

export function createVaultCrypto(deps: VaultCryptoDeps): VaultCrypto {
	const { crypto, storage } = deps;

	async function decryptBoundToContext(
		data: EncryptedData,
		key: KeyRef,
		context: EncryptionContext,
	): Promise<string> {
		return crypto.decrypt(data, key, context);
	}

	function parseEncryptedData(serialized: string): EncryptedData {
		return JSON.parse(serialized) as EncryptedData;
	}

	function attachmentContext(
		scope: AttachmentScope,
		field: AttachmentField,
	): EncryptionContext {
		switch (field) {
			case "name":
				return buildAttachmentNameEncryptionContext(scope);
			case "contentType":
				return buildAttachmentContentTypeEncryptionContext(scope);
			case "blob":
				return buildAttachmentBlobEncryptionContext(scope);
		}
	}

	async function unwrapVaultKey({
		encryptedVaultKey,
		masterUnlockKey,
		encryptedPrivateKey,
		expectedVaultId,
		expectedUserId,
	}: UnwrapVaultKeyInput): Promise<KeyRef> {
		if (isOwnerWrappedVaultKey(encryptedVaultKey)) {
			const wrapped = JSON.parse(encryptedVaultKey) as WrappedVaultKey;
			const wrapContext = wrapped.context;
			if (!wrapContext) {
				throw new Error("Missing vault key wrap context");
			}
			if (wrapContext.purpose !== VAULT_KEY_WRAP_PURPOSE) {
				throw new Error("Invalid vault key wrap purpose");
			}
			if (
				!Number.isInteger(wrapContext.keyVersion) ||
				wrapContext.keyVersion < 1
			) {
				throw new Error("Invalid vault key wrap version");
			}
			if (expectedVaultId && wrapContext.vaultId !== expectedVaultId) {
				throw new Error("Vault key wrap vault mismatch");
			}
			if (expectedUserId && wrapContext.userId !== expectedUserId) {
				throw new Error("Vault key wrap user mismatch");
			}

			const encryptedData = {
				ciphertext: wrapped.ciphertext,
				iv: wrapped.iv,
				algorithm: wrapped.algorithm,
			};
			const context = buildVaultKeyEncryptionContext({
				vaultId: wrapContext.vaultId,
				userId: wrapContext.userId,
				keyVersion: wrapContext.keyVersion,
			});
			return crypto.unwrapKey(encryptedData, masterUnlockKey, context);
		}

		if (!encryptedPrivateKey) {
			throw new Error(
				"Encrypted private key not available. Please log in again.",
			);
		}

		return crypto.decryptRsaWrappedKey(
			encryptedVaultKey,
			parseEncryptedData(encryptedPrivateKey),
			masterUnlockKey,
			null,
		);
	}

	async function unwrapStoredVaultKey({
		encryptedVaultKey,
		vaultId,
		userId,
		accountId,
	}: StoredVaultKeyInput): Promise<KeyRef> {
		const masterUnlockKey = await storage.getMasterUnlockKey(accountId);
		if (!masterUnlockKey) {
			throw new Error("Master Unlock Key not available. Please log in again.");
		}

		return unwrapVaultKey({
			encryptedVaultKey,
			masterUnlockKey,
			encryptedPrivateKey: await storage.getEncryptedPrivateKey(accountId),
			expectedVaultId: vaultId,
			expectedUserId:
				userId ??
				(await storage.getStoredSessionData(accountId))?.userId ??
				undefined,
		});
	}

	return {
		async validateKdfProfile(
			profile: KdfProfile,
			accountId?: string,
		): Promise<KdfProfile> {
			const pinned = accountId
				? await storage.getPinnedKdfProfile(accountId)
				: null;
			validateKdfProfileOrThrow(profile, pinned);
			return profile;
		},

		async deriveAccountKeys(
			input: DeriveAccountKeysInput,
		): Promise<DerivedAccountKeys> {
			const pinned = input.accountId
				? await storage.getPinnedKdfProfile(input.accountId)
				: null;
			validateKdfProfileOrThrow(input.profile, pinned);

			const masterKey = await crypto.deriveMasterKey(
				input.accountPassword,
				input.secretKey,
				input.email,
				input.profile,
			);
			let masterUnlockKey: KeyRef | null = null;
			try {
				const derivedKeys = await crypto.deriveKeysFromMasterKey(
					masterKey,
					input.email,
				);
				masterUnlockKey = derivedKeys.masterUnlockKey;
				let srpPassword: string;
				try {
					srpPassword = await crypto.deriveSrpPassword(derivedKeys.authKey);
				} finally {
					await crypto.destroyKey(derivedKeys.authKey);
				}

				const result: DerivedAccountKeys = {
					srpPassword,
					masterUnlockKey,
					encryptedMasterKey: input.recoveryKey
						? await crypto.encryptMasterKey(
								masterKey,
								input.recoveryKey,
								input.email,
							)
						: null,
				};
				masterUnlockKey = null;
				return result;
			} finally {
				if (masterUnlockKey) {
					await crypto.destroyKey(masterUnlockKey);
				}
				await crypto.destroyKey(masterKey);
			}
		},

		async getVaultKey({ vaultId, userId, accountId }): Promise<KeyRef | null> {
			const vaultKeys = await storage.getVaultKeys(accountId);
			const entry = vaultKeys?.find((vaultKey) => vaultKey.vaultId === vaultId);
			if (!entry) {
				return null;
			}

			return unwrapStoredVaultKey({
				encryptedVaultKey: entry.encryptedVaultKey,
				vaultId,
				userId,
				accountId,
			});
		},

		unwrapStoredVaultKey,

		unwrapVaultKey,

		async wrapVaultKeyForOwner({
			vaultKey,
			masterUnlockKey,
			vaultId,
			userId,
			keyVersion,
		}: WrapVaultKeyForOwnerInput): Promise<string> {
			return crypto.encryptVaultKeyWithMuk(
				vaultKey,
				masterUnlockKey,
				vaultId,
				userId,
				keyVersion,
			);
		},

		async encryptItem(
			plaintext: string,
			vaultKey: KeyRef,
			scope: ItemWriteScope,
		): Promise<EncryptedData> {
			return crypto.encrypt(
				plaintext,
				vaultKey,
				buildItemEncryptionContext(scope),
			);
		},

		async decryptStoredItem(
			item: StoredItemCiphertext,
			vaultKey: KeyRef,
		): Promise<string> {
			return decryptBoundToContext(
				storedItemData(item),
				vaultKey,
				buildStoredItemEncryptionContext(item),
			);
		},

		async decryptStoredItems(
			requests: readonly DecryptStoredItemRequest[],
		): Promise<readonly DecryptManyResult[]> {
			return crypto.decryptMany(
				requests.map(({ item, vaultKey }) => ({
					id: item.id,
					data: storedItemData(item),
					key: vaultKey,
					context: buildStoredItemEncryptionContext(item),
				})),
			);
		},

		async encryptAttachment(
			plaintext: string,
			vaultKey: KeyRef,
			scope: AttachmentScope,
			field: AttachmentField,
		): Promise<EncryptedData> {
			return crypto.encrypt(
				plaintext,
				vaultKey,
				attachmentContext(scope, field),
			);
		},

		async decryptAttachment(
			data: EncryptedData,
			vaultKey: KeyRef,
			scope: AttachmentScope,
			field: AttachmentField,
		): Promise<string> {
			return decryptBoundToContext(
				data,
				vaultKey,
				attachmentContext(scope, field),
			);
		},

		async decryptAttachmentMeta(
			encrypted: EncryptedAttachmentMetaInput,
			vaultKey: KeyRef,
			scope: AttachmentScope,
		): Promise<{ name: string; contentType: string }> {
			const [name, contentType] = await Promise.all([
				decryptBoundToContext(
					{
						ciphertext: encrypted.encryptedName,
						iv: encrypted.encryptionIv,
						algorithm: encrypted.encryptionAlgorithm,
					},
					vaultKey,
					buildAttachmentNameEncryptionContext(scope),
				),
				decryptBoundToContext(
					{
						ciphertext: encrypted.encryptedContentType,
						iv: encrypted.encryptedContentTypeIv,
						algorithm: encrypted.encryptionAlgorithm,
					},
					vaultKey,
					buildAttachmentContentTypeEncryptionContext(scope),
				),
			]);
			return { name, contentType };
		},

		async generateAttachmentKey() {
			return crypto.generateEncryptionKey();
		},

		async destroyAttachmentKey(key) {
			await crypto.destroyKey(key);
		},

		async wrapAttachmentKey(attachmentKey, vaultKey, scope) {
			return crypto.wrapKey(
				attachmentKey,
				vaultKey,
				buildAttachmentKeyEncryptionContext(scope),
			);
		},

		async unwrapAttachmentKey(encryptedAttachmentKey, vaultKey, scope) {
			return crypto.unwrapKey(
				encryptedAttachmentKey,
				vaultKey,
				buildAttachmentKeyEncryptionContext(scope),
			);
		},

		async decryptPrivateKey(
			encryptedPrivateKey: string,
			masterUnlockKey: KeyRef,
		): Promise<string> {
			return crypto.decrypt(
				parseEncryptedData(encryptedPrivateKey),
				masterUnlockKey,
				null,
			);
		},
	};
}

// ============================================================================
// The account key ceremonies
// ============================================================================

/**
 * A ceremony replaces account key material and tells the server about it. Each one is a
 * partial-failure hazard of the worst kind: a vault key re-wrapped under a master unlock key
 * the server never hears about, or a server that accepts new keys this device then fails to
 * adopt, leaves a vault nobody can open. Five rules, followed by every ceremony below:
 *
 * 1. **Prove the password first.** The current master password is checked against the
 *    account's stored private key before any new key is minted, so a typo costs nothing and
 *    reaches nothing.
 * 2. **Re-wrap everything in memory, then commit once.** The server mutation is the single
 *    commit point and carries the whole set — private key, every re-wrapped vault key, the
 *    new SRP verifier and the new KDF profile together. A failure anywhere before it leaves
 *    the account exactly as it was.
 * 3. **A vault key that cannot be re-wrapped fails the ceremony**, rather than being skipped.
 *    Skipping it would commit a new master unlock key that does not open that vault.
 * 4. **Adopt locally only after the server has committed**, and report a failure to adopt as
 *    {@link LocalKeyAdoptionError}. That is not the ceremony failing: the account's keys HAVE
 *    changed, and the user must sign in with the new ones rather than retry with the old.
 * 5. **Own every `KeyRef` minted here.** A ceremony destroys the keys it derives, including
 *    on the failure paths, and returns at most one for the caller to take over.
 *
 * The server clears `encrypted_master_key` and `recovery_key_hint` on all three re-key
 * mutations, because a Recovery Key seals the *master key* these ceremonies replace. Every
 * one of them therefore leaves the account with no Recovery Key until
 * {@link prepareRecoveryKey} runs again — which is what their warnings tell the user.
 */

/** A vault key on the wire: the wrapped key and the vault it opens. */
export interface WrappedVaultKeyRecord {
	vaultId: string;
	encryptedVaultKey: string;
}

/** The payload shape shared by `changePassword`, `updateEmail` and `regenerateSecretKey`. */
export interface AccountReKeyPayload {
	srpSalt: string;
	srpVerifier: string;
	encryptedPrivateKey: string;
	/** Only the keys that changed. RSA-wrapped keys are not tied to the master unlock key. */
	encryptedVaultKeys: WrappedVaultKeyRecord[];
	kdfParams: KdfProfile;
}

/**
 * The master password did not open the account's stored private key. Nothing was sent and
 * nothing changed, so the caller can simply ask again.
 */
export class InvalidAccountPasswordError extends Error {
	constructor(options?: { cause?: unknown }) {
		super("The master password did not open this account.", options);
		this.name = "InvalidAccountPasswordError";
	}
}

/** The supplied Recovery Key is not a well-formed one. Nothing was sent. */
export class InvalidRecoveryKeyError extends Error {
	constructor() {
		super("The Recovery Key is not in the expected format.");
		this.name = "InvalidRecoveryKeyError";
	}
}

/**
 * The server committed the new keys, but writing them to local storage did not finish.
 * The account's keys really did change; this device's copy is the part that is stale, and a
 * full sign-in with the new material is the fix. Distinguishing this from a failed ceremony
 * matters because the two need opposite advice.
 */
export class LocalKeyAdoptionError extends Error {
	constructor(options?: { cause?: unknown }) {
		super(
			"Account keys were changed on the server but could not be stored locally.",
			options,
		);
		this.name = "LocalKeyAdoptionError";
	}
}

/** What a ceremony needs from the account store, on top of {@link VaultCryptoStore}. */
export interface AccountKeyStore extends VaultCryptoStore {
	getStoredSessionData(
		accountId?: string,
	): Promise<{ userId: string; expiresAt?: number; sessionId?: string } | null>;
	storePinnedKdfProfile(profile: KdfProfile, accountId?: string): Promise<void>;
	storeSecretKey(key: string, accountId?: string): Promise<void>;
	storeEncryptedPrivateKey(
		encryptedPrivateKey: string,
		accountId?: string,
	): Promise<void>;
	storeVaultKeys(vaultKeys: VaultKeyEntry[], accountId?: string): Promise<void>;
	/** Borrows the ref. */
	storeSessionData(
		masterUnlockKey: KeyRef,
		accountId: string,
		email: string,
		userId: string,
		expiresAt?: SessionExpiryInput,
		sessionId?: string,
	): Promise<void>;
	/** Takes ownership of the ref. */
	setMasterUnlockKey(key: KeyRef, accountId?: string): Promise<void>;
}

/**
 * Recovery runs before this device has an account: there is no KDF pin to check against and
 * no cached key to read, and every value the ceremony needs arrives from the server.
 */
const NO_LOCAL_ACCOUNT: VaultCryptoStore = {
	async getVaultKeys() {
		return null;
	},
	async getMasterUnlockKey() {
		return null;
	},
	async getEncryptedPrivateKey() {
		return null;
	},
	async getStoredSessionData() {
		return null;
	},
	async getPinnedKdfProfile() {
		return null;
	},
};

/**
 * The version an owner-wrapped key was sealed at, which its replacement has to keep: the
 * version is bound into the AAD, so re-wrapping at a different one silently produces a key
 * that no longer opens under the context the vault will be read with.
 */
function ownerWrapKeyVersion(encryptedVaultKey: string): number {
	const parsed = JSON.parse(encryptedVaultKey) as WrappedVaultKey;
	const keyVersion = parsed.context.keyVersion;
	if (!Number.isInteger(keyVersion) || keyVersion < 1) {
		throw new Error("Invalid vault key wrap version");
	}
	return keyVersion;
}

interface ReKeyedAccount extends AccountReKeyPayload {
	/** The whole set with the re-wrapped entries replaced — what a device caches. */
	vaultKeys: VaultKeyEntry[];
	/** Caller owns this and must destroy it. */
	masterUnlockKey: KeyRef;
}

interface ReKeyInput {
	accountId: string;
	userId: string;
	/** The email the account's current keys were derived from. */
	currentEmail: string;
	/** The email the new keys are derived from — the same one unless this is an email change. */
	nextEmail: string;
	currentPassword: string;
	nextPassword: string;
	currentSecretKey: string;
	nextSecretKey: string;
	encryptedPrivateKey: string;
	vaultKeys: readonly VaultKeyEntry[];
}

/**
 * The body all three re-key ceremonies share: prove the password, derive the replacement
 * account keys, and re-wrap everything the master unlock key protects under them. Sends
 * nothing — the caller commits.
 */
async function reKeyAccount(
	input: ReKeyInput,
	deps: { crypto: CryptoPort; storage: AccountKeyStore },
): Promise<ReKeyedAccount> {
	const { crypto, storage } = deps;
	const vaultCrypto = createVaultCrypto({ crypto, storage });

	const currentProfile = await storage.getPinnedKdfProfile(input.accountId);
	if (!currentProfile) {
		throw new Error("Pinned KDF profile missing; sign in again");
	}

	const current = await vaultCrypto.deriveAccountKeys({
		accountPassword: input.currentPassword,
		secretKey: input.currentSecretKey,
		email: input.currentEmail,
		profile: currentProfile,
		accountId: input.accountId,
	});

	try {
		let privateKeyPem: string;
		try {
			privateKeyPem = await vaultCrypto.decryptPrivateKey(
				input.encryptedPrivateKey,
				current.masterUnlockKey,
			);
		} catch (cause) {
			throw new InvalidAccountPasswordError({ cause });
		}

		// The pin guards against a *server* offering weaker parameters. A re-key is the
		// user replacing their own key material, so it replaces the pin too; only the
		// baseline policy applies.
		const nextProfile = currentKdfProfile();
		validateKdfProfileOrThrow(nextProfile);

		const next = await vaultCrypto.deriveAccountKeys({
			accountPassword: input.nextPassword,
			secretKey: input.nextSecretKey,
			email: input.nextEmail,
			profile: nextProfile,
		});

		try {
			const registration = await crypto.generateSrpRegistration(
				next.srpPassword,
			);
			const encryptedPrivateKey = JSON.stringify(
				await crypto.encrypt(privateKeyPem, next.masterUnlockKey, null),
			);

			const encryptedVaultKeys: WrappedVaultKeyRecord[] = [];
			const vaultKeys: VaultKeyEntry[] = [];
			for (const entry of input.vaultKeys) {
				// An RSA-wrapped key belongs to a vault someone else owns; it is sealed to
				// this account's public key and the master unlock key never touches it.
				if (!isOwnerWrappedVaultKey(entry.encryptedVaultKey)) {
					vaultKeys.push(entry);
					continue;
				}

				const vaultKey = await vaultCrypto.unwrapVaultKey({
					encryptedVaultKey: entry.encryptedVaultKey,
					masterUnlockKey: current.masterUnlockKey,
					expectedVaultId: entry.vaultId,
					expectedUserId: input.userId,
				});
				try {
					const encryptedVaultKey = await vaultCrypto.wrapVaultKeyForOwner({
						vaultKey,
						masterUnlockKey: next.masterUnlockKey,
						vaultId: entry.vaultId,
						userId: input.userId,
						keyVersion: ownerWrapKeyVersion(entry.encryptedVaultKey),
					});
					encryptedVaultKeys.push({
						vaultId: entry.vaultId,
						encryptedVaultKey,
					});
					vaultKeys.push({ ...entry, encryptedVaultKey });
				} finally {
					await crypto.destroyKey(vaultKey);
				}
			}

			return {
				srpSalt: registration.salt,
				srpVerifier: registration.verifier,
				encryptedPrivateKey,
				encryptedVaultKeys,
				kdfParams: nextProfile,
				vaultKeys,
				masterUnlockKey: next.masterUnlockKey,
			};
		} catch (error) {
			await crypto.destroyKey(next.masterUnlockKey);
			throw error;
		}
	} finally {
		await crypto.destroyKey(current.masterUnlockKey);
	}
}

/** Runs the local writes that follow a committed re-key, as one all-or-nothing report. */
async function adopt(work: () => Promise<void>): Promise<void> {
	try {
		await work();
	} catch (cause) {
		throw new LocalKeyAdoptionError({ cause });
	}
}

// ----------------------------------------------------------------------------
// 1 · Change the master password
// ----------------------------------------------------------------------------

export interface ChangeAccountPasswordInput {
	accountId: string;
	email: string;
	userId: string;
	currentPassword: string;
	newPassword: string;
	secretKey: string;
	/** The account's RSA private key as the server holds it. */
	encryptedPrivateKey: string;
	/** Every vault key this account holds, owner-wrapped and RSA-wrapped alike. */
	vaultKeys: readonly VaultKeyEntry[];
}

/**
 * Re-keys the account under a new master password.
 *
 * The server revokes every session, this one included, so nothing is adopted locally beyond
 * the KDF pin: the next step for the caller is a full sign-in.
 */
export async function changeAccountPassword(
	input: ChangeAccountPasswordInput,
	deps: {
		crypto: CryptoPort;
		storage: AccountKeyStore;
		commit: (payload: AccountReKeyPayload) => Promise<unknown>;
	},
): Promise<{ kdfProfile: KdfProfile }> {
	const reKeyed = await reKeyAccount(
		{
			accountId: input.accountId,
			userId: input.userId,
			currentEmail: input.email,
			nextEmail: input.email,
			currentPassword: input.currentPassword,
			nextPassword: input.newPassword,
			currentSecretKey: input.secretKey,
			nextSecretKey: input.secretKey,
			encryptedPrivateKey: input.encryptedPrivateKey,
			vaultKeys: input.vaultKeys,
		},
		deps,
	);

	try {
		await deps.commit(toReKeyPayload(reKeyed));
	} finally {
		await deps.crypto.destroyKey(reKeyed.masterUnlockKey);
	}

	// A stale pin would have `performSRPUnlock` derive at the old work factor and produce a
	// key that opens nothing, so it is written even though the session is already gone.
	await adopt(async () => {
		await deps.storage.storePinnedKdfProfile(
			reKeyed.kdfParams,
			input.accountId,
		);
	});

	return { kdfProfile: reKeyed.kdfParams };
}

// ----------------------------------------------------------------------------
// 2 · Change the account email
// ----------------------------------------------------------------------------

export interface ChangeAccountEmailInput {
	accountId: string;
	currentEmail: string;
	newEmail: string;
	userId: string;
	currentPassword: string;
	secretKey: string;
	encryptedPrivateKey: string;
	vaultKeys: readonly VaultKeyEntry[];
}

/**
 * Re-keys the account under a new email.
 *
 * The email is a KDF input, so changing it changes every account key even though the
 * password and Secret Key are untouched — which is why this is a full re-key and not an
 * update. As with a password change the server revokes every session.
 */
export async function changeAccountEmail(
	input: ChangeAccountEmailInput,
	deps: {
		crypto: CryptoPort;
		storage: AccountKeyStore;
		commit: (
			payload: AccountReKeyPayload & { newEmail: string },
		) => Promise<unknown>;
	},
): Promise<{ kdfProfile: KdfProfile; newEmail: string }> {
	const newEmail = input.newEmail.trim().toLowerCase();
	const reKeyed = await reKeyAccount(
		{
			accountId: input.accountId,
			userId: input.userId,
			currentEmail: input.currentEmail,
			nextEmail: newEmail,
			currentPassword: input.currentPassword,
			nextPassword: input.currentPassword,
			currentSecretKey: input.secretKey,
			nextSecretKey: input.secretKey,
			encryptedPrivateKey: input.encryptedPrivateKey,
			vaultKeys: input.vaultKeys,
		},
		deps,
	);

	try {
		await deps.commit({ ...toReKeyPayload(reKeyed), newEmail });
	} finally {
		await deps.crypto.destroyKey(reKeyed.masterUnlockKey);
	}

	await adopt(async () => {
		await deps.storage.storePinnedKdfProfile(
			reKeyed.kdfParams,
			input.accountId,
		);
	});

	return { kdfProfile: reKeyed.kdfParams, newEmail };
}

// ----------------------------------------------------------------------------
// 3 · Regenerate the Secret Key
// ----------------------------------------------------------------------------

export interface RegenerateSecretKeyInput {
	accountId: string;
	email: string;
	userId: string;
	currentPassword: string;
	currentSecretKey: string;
	/** Shown to the user and acknowledged before this runs, so it is generated by the caller. */
	newSecretKey: string;
	encryptedPrivateKey: string;
	vaultKeys: readonly VaultKeyEntry[];
}

/**
 * Re-keys the account under a new Secret Key, keeping the session.
 *
 * This is the one re-key the server lets the current session survive, so it is also the one
 * that has to move this device onto the new keys. Everything sealed under the old master
 * unlock key — the private key, the owner-wrapped vault keys, the quick-unlock session blob
 * — is replaced before the cached key is swapped, because a device holding the new key and
 * the old ciphertext can open nothing.
 */
export async function regenerateAccountSecretKey(
	input: RegenerateSecretKeyInput,
	deps: {
		crypto: CryptoPort;
		storage: AccountKeyStore;
		commit: (
			payload: AccountReKeyPayload & { secretKeyHint: string },
		) => Promise<unknown>;
	},
): Promise<{ kdfProfile: KdfProfile }> {
	const reKeyed = await reKeyAccount(
		{
			accountId: input.accountId,
			userId: input.userId,
			currentEmail: input.email,
			nextEmail: input.email,
			currentPassword: input.currentPassword,
			nextPassword: input.currentPassword,
			currentSecretKey: input.currentSecretKey,
			nextSecretKey: input.newSecretKey,
			encryptedPrivateKey: input.encryptedPrivateKey,
			vaultKeys: input.vaultKeys,
		},
		deps,
	);

	try {
		await deps.commit({
			...toReKeyPayload(reKeyed),
			secretKeyHint: getSecretKeyHint(input.newSecretKey),
		});
	} catch (error) {
		await deps.crypto.destroyKey(reKeyed.masterUnlockKey);
		throw error;
	}

	try {
		await adopt(async () => {
			const { storage } = deps;
			await storage.storePinnedKdfProfile(reKeyed.kdfParams, input.accountId);
			await storage.storeSecretKey(input.newSecretKey, input.accountId);
			await storage.storeEncryptedPrivateKey(
				reKeyed.encryptedPrivateKey,
				input.accountId,
			);
			await storage.storeVaultKeys(reKeyed.vaultKeys, input.accountId);

			const session = await storage.getStoredSessionData(input.accountId);
			await storage.storeSessionData(
				reKeyed.masterUnlockKey,
				input.accountId,
				input.email,
				input.userId,
				session?.expiresAt,
				session?.sessionId,
			);
			// Last, and the point of no return: the store owns the ref from here.
			await storage.setMasterUnlockKey(
				reKeyed.masterUnlockKey,
				input.accountId,
			);
		});
	} catch (error) {
		await deps.crypto.destroyKey(reKeyed.masterUnlockKey);
		throw error;
	}

	return { kdfProfile: reKeyed.kdfParams };
}

// ----------------------------------------------------------------------------
// 4 and 5 · Set up, or regenerate, the Recovery Key
// ----------------------------------------------------------------------------

export interface PrepareRecoveryKeyInput {
	accountId: string;
	email: string;
	password: string;
	secretKey: string;
	encryptedPrivateKey: string;
}

export interface PreparedRecoveryKey {
	/** Show this to the user once. Nothing stores it. */
	recoveryKey: string;
	/** The master key sealed under the Recovery Key, serialized for the server. */
	encryptedMasterKey: string;
	recoveryKeyHint: string;
}

/**
 * Mints a Recovery Key and seals the account's master key under it.
 *
 * Setting one up for the first time and replacing an existing one are the same ceremony:
 * the server's `storeRecoveryKey` overwrites unconditionally and only reports which of the
 * two happened in its audit log. Nothing is sent from here — the caller shows the key,
 * takes the user's acknowledgement, and only then sends `encryptedMasterKey` and
 * `recoveryKeyHint`, because a Recovery Key registered before the user has written it down
 * is a Recovery Key they do not have.
 */
export async function prepareRecoveryKey(
	input: PrepareRecoveryKeyInput,
	deps: { crypto: CryptoPort; storage: AccountKeyStore },
): Promise<PreparedRecoveryKey> {
	const { crypto, storage } = deps;
	const vaultCrypto = createVaultCrypto({ crypto, storage });

	const profile = await storage.getPinnedKdfProfile(input.accountId);
	if (!profile) {
		throw new Error("Pinned KDF profile missing; sign in again");
	}

	const recoveryKey = await crypto.generateRecoveryKey();
	const derived = await vaultCrypto.deriveAccountKeys({
		accountPassword: input.password,
		secretKey: input.secretKey,
		email: input.email,
		profile,
		accountId: input.accountId,
		recoveryKey,
	});

	try {
		try {
			await vaultCrypto.decryptPrivateKey(
				input.encryptedPrivateKey,
				derived.masterUnlockKey,
			);
		} catch (cause) {
			throw new InvalidAccountPasswordError({ cause });
		}

		if (!derived.encryptedMasterKey) {
			throw new Error("Recovery envelope was not produced");
		}

		return {
			recoveryKey,
			encryptedMasterKey: JSON.stringify(derived.encryptedMasterKey),
			recoveryKeyHint: getRecoveryKeyHint(recoveryKey),
		};
	} finally {
		await crypto.destroyKey(derived.masterUnlockKey);
	}
}

// ----------------------------------------------------------------------------
// 6 · Recover the account with the Recovery Key
// ----------------------------------------------------------------------------

/** What the server hands back once a recovery token has been proven. */
export interface AccountRecoveryData {
	userId: string;
	encryptedMasterKey: string;
	encryptedPrivateKey: string;
	vaultKeys: readonly WrappedVaultKeyRecord[];
}

export interface RecoverAccountInput {
	email: string;
	recoveryKey: string;
	newPassword: string;
}

export interface RecoveredAccount {
	userId: string;
	/** Freshly minted: recovery always replaces the Secret Key. Show it to the user. */
	secretKey: string;
	kdfProfile: KdfProfile;
	encryptedPrivateKey: string;
	/** Caller owns this and must destroy it, or hand it to the store. */
	masterUnlockKey: KeyRef;
}

/**
 * Rebuilds the account's keys from the Recovery Key and a new master password.
 *
 * The Recovery Key opens the *master key*, from which the old master unlock key is derived;
 * everything the account owns is then re-wrapped under keys derived from a new password and
 * a new Secret Key. The Recovery Key itself is carried over and re-seals the new master key,
 * so the emergency kit the user is holding stays valid — losing it here would leave the
 * account with no recovery path at the exact moment it just needed one.
 *
 * Runs with no local account: the KDF profile is the current policy default, not a pin.
 */
export async function recoverAccount<TResetResult>(
	input: RecoverAccountInput,
	deps: {
		crypto: CryptoPort;
		loadRecoveryData: () => Promise<AccountRecoveryData>;
		commit: (payload: {
			srpSalt: string;
			srpVerifier: string;
			encryptedPrivateKey: string;
			encryptedMasterKey: string;
			recoveryKeyHint: string;
			secretKeyHint: string;
			encryptedVaultKeys: WrappedVaultKeyRecord[];
			kdfParams: KdfProfile;
		}) => Promise<TResetResult>;
	},
): Promise<RecoveredAccount & { result: TResetResult }> {
	const { crypto } = deps;
	const vaultCrypto = createVaultCrypto({ crypto, storage: NO_LOCAL_ACCOUNT });
	const { email, recoveryKey } = input;

	if (!(await crypto.validateRecoveryKey(recoveryKey))) {
		throw new InvalidRecoveryKeyError();
	}

	const recoveryData = await deps.loadRecoveryData();

	const oldMasterKey = await crypto.decryptMasterKey(
		JSON.parse(recoveryData.encryptedMasterKey) as EncryptedData,
		recoveryKey,
		email,
	);
	let oldKeys: { authKey: KeyRef; masterUnlockKey: KeyRef };
	try {
		oldKeys = await crypto.deriveKeysFromMasterKey(oldMasterKey, email);
	} finally {
		await crypto.destroyKey(oldMasterKey);
	}

	try {
		// Recovery re-keys from scratch, so the old auth key is never needed.
		await crypto.destroyKey(oldKeys.authKey);

		const privateKeyPem = await vaultCrypto.decryptPrivateKey(
			recoveryData.encryptedPrivateKey,
			oldKeys.masterUnlockKey,
		);

		const secretKey = await crypto.generateSecretKey();
		const kdfParams = currentKdfProfile();
		validateKdfProfileOrThrow(kdfParams);

		const next = await vaultCrypto.deriveAccountKeys({
			accountPassword: input.newPassword,
			secretKey,
			email,
			profile: kdfParams,
			recoveryKey,
		});

		try {
			if (!next.encryptedMasterKey) {
				throw new Error("Recovery envelope was not produced");
			}

			const registration = await crypto.generateSrpRegistration(
				next.srpPassword,
			);
			const encryptedPrivateKey = JSON.stringify(
				await crypto.encrypt(privateKeyPem, next.masterUnlockKey, null),
			);

			const encryptedVaultKeys: WrappedVaultKeyRecord[] = [];
			for (const entry of recoveryData.vaultKeys) {
				if (!isOwnerWrappedVaultKey(entry.encryptedVaultKey)) {
					continue;
				}
				const vaultKey = await vaultCrypto.unwrapVaultKey({
					encryptedVaultKey: entry.encryptedVaultKey,
					masterUnlockKey: oldKeys.masterUnlockKey,
					expectedVaultId: entry.vaultId,
					expectedUserId: recoveryData.userId,
				});
				try {
					encryptedVaultKeys.push({
						vaultId: entry.vaultId,
						encryptedVaultKey: await vaultCrypto.wrapVaultKeyForOwner({
							vaultKey,
							masterUnlockKey: next.masterUnlockKey,
							vaultId: entry.vaultId,
							userId: recoveryData.userId,
							keyVersion: ownerWrapKeyVersion(entry.encryptedVaultKey),
						}),
					});
				} finally {
					await crypto.destroyKey(vaultKey);
				}
			}

			const result = await deps.commit({
				srpSalt: registration.salt,
				srpVerifier: registration.verifier,
				encryptedPrivateKey,
				encryptedMasterKey: JSON.stringify(next.encryptedMasterKey),
				recoveryKeyHint: getRecoveryKeyHint(recoveryKey),
				secretKeyHint: getSecretKeyHint(secretKey),
				encryptedVaultKeys,
				kdfParams,
			});

			return {
				result,
				userId: recoveryData.userId,
				secretKey,
				kdfProfile: kdfParams,
				encryptedPrivateKey,
				masterUnlockKey: next.masterUnlockKey,
			};
		} catch (error) {
			await crypto.destroyKey(next.masterUnlockKey);
			throw error;
		}
	} finally {
		await crypto.destroyKey(oldKeys.masterUnlockKey);
	}
}

// ----------------------------------------------------------------------------
// 7 · Create a new account
// ----------------------------------------------------------------------------

export interface CreateAccountKeysInput {
	email: string;
	password: string;
	/** Shown in the Emergency Kit before this runs, so both are generated by the caller. */
	secretKey: string;
	recoveryKey: string;
}

/** Everything a signup mutation carries, plus the identifiers the AAD is bound to. */
export interface CreatedAccountKeys {
	userId: string;
	vaultId: string;
	kdfProfile: KdfProfile;
	srpSalt: string;
	srpVerifier: string;
	publicKey: string;
	encryptedPrivateKey: string;
	encryptedMasterKey: string;
	encryptedVaultKey: string;
	secretKeyHint: string;
	recoveryKeyHint: string;
	/** Caller owns this and must destroy it, or hand it to the store. */
	masterUnlockKey: KeyRef;
}

/**
 * Mints every key a new account needs and registers it.
 *
 * The user id and the first vault's id are generated here rather than by the server because
 * the vault key's wrap context is bound to both, and that binding has to exist before the
 * account does. If the mutation fails, nothing is left behind: the keys are destroyed and
 * the identifiers are meaningless.
 */
export async function createAccountKeys<TSignupResult>(
	input: CreateAccountKeysInput,
	deps: {
		crypto: CryptoPort;
		commit: (payload: CreatedAccountKeys) => Promise<TSignupResult>;
	},
): Promise<{ keys: CreatedAccountKeys; result: TSignupResult }> {
	const { crypto } = deps;
	const vaultCrypto = createVaultCrypto({ crypto, storage: NO_LOCAL_ACCOUNT });
	const { email, recoveryKey, secretKey } = input;

	const kdfProfile = currentKdfProfile();
	validateKdfProfileOrThrow(kdfProfile);

	const derived = await vaultCrypto.deriveAccountKeys({
		accountPassword: input.password,
		secretKey,
		email,
		profile: kdfProfile,
		recoveryKey,
	});

	try {
		if (!derived.encryptedMasterKey) {
			throw new Error("Recovery envelope was not produced");
		}

		const [userId, vaultId] = await Promise.all([
			crypto.generateUuid(),
			crypto.generateUuid(),
		]);
		const registration = await crypto.generateSrpRegistration(
			derived.srpPassword,
		);
		const rsaKeyPair = await crypto.generateRsaKeyPair();
		const encryptedPrivateKey = JSON.stringify(
			await crypto.encrypt(
				rsaKeyPair.privateKey,
				derived.masterUnlockKey,
				null,
			),
		);

		const vaultKey = await crypto.generateEncryptionKey();
		let encryptedVaultKey: string;
		try {
			encryptedVaultKey = await vaultCrypto.wrapVaultKeyForOwner({
				vaultKey,
				masterUnlockKey: derived.masterUnlockKey,
				vaultId,
				userId,
				keyVersion: 1,
			});
		} finally {
			await crypto.destroyKey(vaultKey);
		}

		const keys: CreatedAccountKeys = {
			userId,
			vaultId,
			kdfProfile,
			srpSalt: registration.salt,
			srpVerifier: registration.verifier,
			publicKey: rsaKeyPair.publicKey,
			encryptedPrivateKey,
			encryptedMasterKey: JSON.stringify(derived.encryptedMasterKey),
			encryptedVaultKey,
			secretKeyHint: getSecretKeyHint(secretKey),
			recoveryKeyHint: getRecoveryKeyHint(recoveryKey),
			masterUnlockKey: derived.masterUnlockKey,
		};

		return { keys, result: await deps.commit(keys) };
	} catch (error) {
		await crypto.destroyKey(derived.masterUnlockKey);
		throw error;
	}
}

function toReKeyPayload(reKeyed: ReKeyedAccount): AccountReKeyPayload {
	return {
		srpSalt: reKeyed.srpSalt,
		srpVerifier: reKeyed.srpVerifier,
		encryptedPrivateKey: reKeyed.encryptedPrivateKey,
		encryptedVaultKeys: reKeyed.encryptedVaultKeys,
		kdfParams: reKeyed.kdfParams,
	};
}
