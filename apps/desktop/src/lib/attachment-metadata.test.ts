import { expect, test } from "bun:test";
import type { AttachmentMeta } from "@bittery/core/hooks";
import { resolveAttachmentMetadata } from "./attachment-metadata";

const metadata: AttachmentMeta = {
	id: "attachment-1",
	itemId: "item-1",
	vaultId: "vault-1",
	storageKey: "blob-1",
	encryptedAttachmentKey: "wrapped-key",
	attachmentKeyIv: "key-iv",
	attachmentKeyAlgorithm: "AES-GCM",
	envelopeVersion: 2,
	encryptedName: "name",
	encryptedContentType: "content-type",
	encryptionIv: "name-iv",
	encryptedContentTypeIv: "type-iv",
	encryptionAlgorithm: "AES-GCM",
	fileSize: 42,
	uploadedBy: "user-1",
	createdAt: "2026-09-07T12:00:00Z",
};

test("presentation callbacks resolve the original encrypted metadata from this Item", () => {
	const selection = {
		id: metadata.id,
		itemId: metadata.itemId,
		vaultId: metadata.vaultId,
	};
	expect(resolveAttachmentMetadata([metadata], selection)).toBe(metadata);
});

test("removed attachments and selections from another Item or Vault cannot resolve", () => {
	for (const selection of [
		{ ...metadata, id: "removed" },
		{ ...metadata, itemId: "other-item" },
		{ ...metadata, vaultId: "other-vault" },
	])
		expect(() => resolveAttachmentMetadata([metadata], selection)).toThrow(
			"Attachment is no longer available",
		);
	expect(() => resolveAttachmentMetadata([], metadata)).toThrow(
		"Attachment is no longer available",
	);
});
