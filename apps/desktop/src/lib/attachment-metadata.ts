import type { AttachmentMeta } from "@bittery/core/hooks";

/** Shared UI returns presentation fields; Desktop still owns the encrypted metadata. */
export function resolveAttachmentMetadata(
	attachments: readonly AttachmentMeta[],
	selection: Pick<AttachmentMeta, "id" | "itemId" | "vaultId">,
): AttachmentMeta {
	const metadata = attachments.find(
		(attachment) =>
			attachment.id === selection.id &&
			attachment.itemId === selection.itemId &&
			attachment.vaultId === selection.vaultId,
	);
	if (!metadata) throw new Error("Attachment is no longer available");
	return metadata;
}
