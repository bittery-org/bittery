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
 * conversion, per-field context wiring and the content-type IV fallback) so the
 * `useItemAttachments` hook and `ItemService.moveItem` share ONE implementation
 * instead of duplicating crypto.
 */

import type { EncryptedData, ICrypto } from "@bittery/types";
import {
	buildAttachmentBlobEncryptionContext,
	buildAttachmentContentTypeEncryptionContext,
	buildAttachmentNameEncryptionContext,
} from "./encryption-context";

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
	/** IV used for `encryptedContentType`. Falls back to `encryptionIv` for old rows. */
	encryptedContentTypeIv: string | null;
	encryptionAlgorithm: string;
}

/**
 * Decrypt an attachment's blob, name and content-type using its source scope.
 * Mirrors the decrypt paths in `useItemAttachments` (blob + name) and
 * `decryptAttachmentMeta` (name + content-type), including the content-type IV
 * fallback for attachments created before the dedicated IV existed.
 */
export async function decryptAttachmentParts(
	crypto: ICrypto,
	vaultKey: Uint8Array,
	scope: AttachmentCryptoScope,
	encrypted: EncryptedAttachmentMetadata,
): Promise<DecryptedAttachmentParts> {
	const base64File = await crypto.decrypt(
		encrypted.blobEnvelope,
		vaultKey,
		buildAttachmentBlobEncryptionContext(scope),
	);
	const name = await crypto.decrypt(
		{
			ciphertext: encrypted.encryptedName,
			iv: encrypted.encryptionIv,
			algorithm: encrypted.encryptionAlgorithm,
		},
		vaultKey,
		buildAttachmentNameEncryptionContext(scope),
	);
	const contentType = await crypto.decrypt(
		{
			ciphertext: encrypted.encryptedContentType,
			iv: encrypted.encryptedContentTypeIv ?? encrypted.encryptionIv,
			algorithm: encrypted.encryptionAlgorithm,
		},
		vaultKey,
		buildAttachmentContentTypeEncryptionContext(scope),
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
	crypto: ICrypto,
	vaultKey: Uint8Array,
	scope: AttachmentCryptoScope,
	parts: DecryptedAttachmentParts,
): Promise<EncryptedAttachmentParts> {
	const blobEnvelope = await crypto.encrypt(
		parts.base64File,
		vaultKey,
		buildAttachmentBlobEncryptionContext(scope),
	);
	const encryptedName = await crypto.encrypt(
		parts.name,
		vaultKey,
		buildAttachmentNameEncryptionContext(scope),
	);
	const encryptedContentType = await crypto.encrypt(
		parts.contentType,
		vaultKey,
		buildAttachmentContentTypeEncryptionContext(scope),
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
