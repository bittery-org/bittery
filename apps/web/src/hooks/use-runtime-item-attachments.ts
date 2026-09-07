import { RuntimeRequestError } from "@bittery/client-runtime/client";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type {
	AtomicAttachmentDownloadSink,
	AtomicAttachmentUploadSource,
} from "@bittery/client-runtime/web";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import type {
	AttachmentItem,
	AttachmentUploadErrorCode,
} from "@bittery/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	attachmentDownloadSinks,
	attachmentUploadSources,
} from "@/lib/crypto";

export function createFileAttachmentUploadSource(
	file: Blob,
): AtomicAttachmentUploadSource {
	let offset = 0;
	let closed = false;
	return {
		async read(maxBytes) {
			if (closed) throw new Error("Attachment Upload source is closed");
			if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
				throw new Error("Attachment Upload read bound is invalid");
			if (offset === file.size) return null;
			const end = Math.min(file.size, offset + maxBytes);
			const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
			offset = end;
			return bytes;
		},
		async close() {
			closed = true;
		},
	};
}

export interface AttachmentDownloadBuffer extends AtomicAttachmentDownloadSink {
	take(): Uint8Array;
}

export function createAttachmentDownloadBuffer(
	expectedBytes: number,
): AttachmentDownloadBuffer {
	if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
		throw new Error("Attachment Download size is invalid");
	let bytes = new Uint8Array(expectedBytes);
	let offset = 0;
	let committed = false;
	return {
		async write(chunk) {
			if (committed || offset + chunk.byteLength > bytes.byteLength)
				throw new Error("Attachment Download length is invalid");
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		},
		async commit() {
			if (offset !== bytes.byteLength)
				throw new Error("Attachment Download is incomplete");
			committed = true;
		},
		async discard() {
			bytes.fill(0);
			offset = 0;
			committed = false;
		},
		take() {
			if (!committed)
				throw new Error("Attachment Download is not committed");
			const result = bytes;
			bytes = new Uint8Array(0);
			offset = 0;
			committed = false;
			return result;
		},
	};
}

export function getRuntimeAttachmentUploadErrorCode(
	error: unknown,
): AttachmentUploadErrorCode {
	if (!(error instanceof RuntimeRequestError)) return "unknown";
	if (error.code === "SIZE_REJECTED") return "file-too-large";
	if (error.code === "QUOTA_EXCEEDED") return "storage-limit-reached";
	return "unknown";
}

interface RuntimeAttachmentOwner {
	id: string;
	accountId?: string;
	attachments?: AttachmentItem[];
}

export function useRuntimeItemAttachments(item: RuntimeAttachmentOwner | null) {
	const runtime = useRuntimeClient();
	const api = useApiClient();
	const entitlements = useQuery({
		...apiQueries.billing.entitlements(api),
		enabled: item !== null,
	});
	const accountId = item?.accountId;
	const itemId = item?.id;

	const upload = useMutation({
		mutationFn: async (file: File & { displayName?: string }) => {
			if (!accountId || !itemId)
				throw new Error("Runtime Item authority is unavailable");
			const name = file.displayName?.trim() || file.name;
			const contentType = file.type.trim() || "application/octet-stream";
			const sourceCapabilityId = attachmentUploadSources.grant({
				accountId,
				itemId,
				name,
				contentType,
				expectedBytes: BigInt(file.size),
				source: createFileAttachmentUploadSource(file),
			});
			return runtime.uploadAttachment({
				accountId,
				itemId,
				name,
				contentType,
				fileSize: String(file.size),
				sourceCapabilityId,
			});
		},
	});

	const download = useMutation({
		mutationFn: async (attachment: AttachmentItem) => {
			if (!accountId)
				throw new Error("Runtime Account authority is unavailable");
			if (!attachment.name)
				throw new Error("Runtime Attachment name is unavailable");
			const sink = createAttachmentDownloadBuffer(attachment.fileSize);
			const sinkCapabilityId = attachmentDownloadSinks.grant({
				accountId,
				attachmentId: attachment.id,
				sink,
			});
			try {
				await runtime.downloadAttachment({
					accountId,
					attachmentId: attachment.id,
					sinkCapabilityId,
				});
				return { bytes: sink.take(), fileName: attachment.name };
			} catch (error) {
				await sink.discard();
				throw error;
			}
		},
	});

	const rename = useMutation({
		mutationFn: ({ attachmentId, newName }: { attachmentId: string; newName: string }) => {
			if (!accountId)
				throw new Error("Runtime Account authority is unavailable");
			return runtime.renameAttachment({ accountId, attachmentId, name: newName });
		},
	});
	const remove = useMutation({
		mutationFn: (attachmentId: string) => {
			if (!accountId)
				throw new Error("Runtime Account authority is unavailable");
			return runtime.deleteAttachment({ accountId, attachmentId });
		},
	});

	return {
		attachments: item?.attachments ?? [],
		isLoading: false,
		attachmentMaxFileSizeBytes:
			entitlements.data?.limits?.attachmentMaxFileSizeBytes ?? null,
		decryptMeta: async (attachment: AttachmentItem) => {
			if (!attachment.name)
				throw new Error("Runtime Attachment name is unavailable");
			return { name: attachment.name };
		},
		upload,
		download,
		rename,
		remove,
	};
}
