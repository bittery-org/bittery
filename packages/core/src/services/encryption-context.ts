import type { EncryptionContext } from "@bittery/types";

interface ItemContextInput {
	vaultId: string;
	itemId: string;
	version: number;
	userId: string;
}

interface AttachmentContextInput {
	vaultId: string;
	attachmentKey: string;
	userId: string;
}

function normalizeVersion(version: number): number {
	if (!Number.isFinite(version) || version < 1) {
		return 1;
	}
	return Math.floor(version);
}

export function buildItemEncryptionContext(
	input: ItemContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.itemId,
		entityType: "item",
		version: normalizeVersion(input.version),
		userId: input.userId,
	};
}

export function buildAttachmentNameEncryptionContext(
	input: AttachmentContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.attachmentKey,
		entityType: "attachment_name",
		version: 1,
		userId: input.userId,
	};
}

export function buildAttachmentContentTypeEncryptionContext(
	input: AttachmentContextInput,
): EncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: input.attachmentKey,
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
		entityId: input.attachmentKey,
		entityType: "attachment_blob",
		version: 1,
		userId: input.userId,
	};
}
