/**
 * Shared, platform-agnostic attachment crypto helpers.
 *
 * Attachments are encrypted client-side with the VAULT KEY (the same key used
 * for the item body). Each attachment has THREE independent ciphertexts — blob,
 * name and content-type — each bound to its own encryption context (AAD) built
 * from `vaultId`, `entityId = attachmentKey (= storageKey)`, `userId` and a
 * per-field `entityType`. The blob ciphertext is stored in object storage as a
 * JSON envelope: `JSON.stringify({ ciphertext, iv, algorithm })`.
 *
 * This module extracts the "subtle" pieces (envelope encode/parse, base64
 * conversion and per-field context wiring) so the
 * `useItemAttachments` hook and `ItemService.moveItem` share ONE implementation
 * instead of duplicating crypto.
 */

import type { KeyRef } from "@bittery/crypto-port";
import type { EncryptedData } from "@bittery/types";
import type { VaultCrypto } from "./vault-crypto";

/** Identifies the vault/account/attachment an encryption context is bound to. */
export interface AttachmentCryptoScope {
	vaultId: string;
	/** The attachment storage key (server-minted, HMAC-signed). */
	attachmentKey: string;
	userId: string;
}

/**
 * Encode an encrypted blob into the object-storage envelope (a UTF-8 encoded
 * `JSON.stringify({ ciphertext, iv, algorithm })`), ready to PUT to the
 * presigned upload URL.
 */
export function encodeAttachmentBlobEnvelope(encryptedBlob: EncryptedData) {
	return new TextEncoder().encode(JSON.stringify(encryptedBlob));
}

/** Parse the object-storage envelope fetched from a presigned download URL. */
export function parseAttachmentBlobEnvelope(text: string): EncryptedData {
	return JSON.parse(text) as EncryptedData;
}

/** Convert bytes to a base64 string (the plaintext form of an attachment blob). */
export function attachmentBytesToBase64(bytes: Uint8Array): string {
	return btoa(
		bytes.reduce((data, byte) => data + String.fromCharCode(byte), ""),
	);
}

/** Convert a base64 string back to bytes. */
export function attachmentBase64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

/** The plaintext parts of an attachment (blob kept as base64, like the wire form). */
export interface DecryptedAttachmentParts {
	/** Base64-encoded raw file bytes. */
	base64File: string;
	name: string;
	contentType: string;
}

/** The encrypted ciphertexts + IVs the server persists for an attachment. */
export interface EncryptedAttachmentMetadata {
	blobEnvelope: EncryptedData;
	encryptedName: string;
	encryptedContentType: string;
	/** IV used for `encryptedName`. */
	encryptionIv: string;
	/** IV used for `encryptedContentType`. */
	encryptedContentTypeIv: string;
	encryptionAlgorithm: string;
}

/** Just the name+content-type ciphertexts (no blob) — what list/detail views need. */
export type EncryptedAttachmentMetaFields = Omit<
	EncryptedAttachmentMetadata,
	"blobEnvelope"
>;

/** Decrypted name + content-type pair returned by {@link decryptAttachmentMeta}. */
export interface DecryptedAttachmentMeta {
	name: string;
	contentType: string;
}

/** Encrypt an attachment's display name under `scope`. */
export async function encryptAttachmentName(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	name: string,
): Promise<EncryptedData> {
	return vaultCrypto.encryptAttachment(name, vaultKey, scope, "name");
}

/** Decrypt an attachment's display name under `scope`. */
export async function decryptAttachmentName(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	encrypted: Pick<EncryptedData, "ciphertext" | "iv" | "algorithm">,
): Promise<string> {
	return vaultCrypto.decryptAttachment(encrypted, vaultKey, scope, "name");
}

/** Decrypt an attachment's content-type under `scope`. */
export async function decryptAttachmentContentType(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	encrypted: {
		ciphertext: string;
		encryptedContentTypeIv: string;
		algorithm: string;
	},
): Promise<string> {
	return vaultCrypto.decryptAttachment(
		{
			ciphertext: encrypted.ciphertext,
			iv: encrypted.encryptedContentTypeIv,
			algorithm: encrypted.algorithm,
		},
		vaultKey,
		scope,
		"contentType",
	);
}

/** Decrypt an attachment's blob (base64 ciphertext envelope) under `scope`. */
export async function decryptAttachmentBlob(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	blobEnvelope: EncryptedData,
): Promise<string> {
	return vaultCrypto.decryptAttachment(blobEnvelope, vaultKey, scope, "blob");
}

/**
 * Decrypt an attachment's name + content-type (no blob) under `scope`.
 * Shared by list/detail views that don't need the (larger) blob ciphertext.
 */
export async function decryptAttachmentMeta(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	encrypted: EncryptedAttachmentMetaFields,
): Promise<DecryptedAttachmentMeta> {
	return vaultCrypto.decryptAttachmentMeta(encrypted, vaultKey, scope);
}

/**
 * Decrypt an attachment's blob, name and content-type using its source scope.
 * Mirrors the decrypt paths in `useItemAttachments` (blob + name) and
 * `decryptAttachmentMeta` (name + content-type).
 */
export async function decryptAttachmentParts(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	encrypted: EncryptedAttachmentMetadata,
): Promise<DecryptedAttachmentParts> {
	const base64File = await decryptAttachmentBlob(
		vaultCrypto,
		vaultKey,
		scope,
		encrypted.blobEnvelope,
	);
	const { name, contentType } = await decryptAttachmentMeta(
		vaultCrypto,
		vaultKey,
		scope,
		encrypted,
	);
	return { base64File, name, contentType };
}

/** Re-encrypted attachment ready to upload + persist under a new scope. */
export interface EncryptedAttachmentParts {
	/** Encrypted blob to PUT to the presigned upload URL. */
	blobEnvelope: EncryptedData;
	encryptedName: string;
	encryptedContentType: string;
	/** IV used for `encryptedName`. */
	encryptionIv: string;
	/** IV used for `encryptedContentType`. */
	encryptedContentTypeIv: string;
	encryptionAlgorithm: string;
}

/**
 * Encrypt an attachment's blob, name and content-type under a target scope.
 * Mirrors the encrypt path in `useItemAttachments`' upload mutation (a fresh IV
 * per field, name IV carried as `encryptionIv`, content-type IV carried
 * separately).
 */
export async function encryptAttachmentParts(
	vaultCrypto: VaultCrypto,
	vaultKey: KeyRef,
	scope: AttachmentCryptoScope,
	parts: DecryptedAttachmentParts,
): Promise<EncryptedAttachmentParts> {
	const blobEnvelope = await vaultCrypto.encryptAttachment(
		parts.base64File,
		vaultKey,
		scope,
		"blob",
	);
	const encryptedName = await encryptAttachmentName(
		vaultCrypto,
		vaultKey,
		scope,
		parts.name,
	);
	const encryptedContentType = await vaultCrypto.encryptAttachment(
		parts.contentType,
		vaultKey,
		scope,
		"contentType",
	);
	return {
		blobEnvelope,
		encryptedName: encryptedName.ciphertext,
		encryptedContentType: encryptedContentType.ciphertext,
		encryptionIv: encryptedName.iv,
		encryptedContentTypeIv: encryptedContentType.iv,
		encryptionAlgorithm: encryptedName.algorithm,
	};
}
