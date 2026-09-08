import { RuntimeRequestError } from "@bittery/client-runtime/client";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { AtomicAttachmentUploadSource } from "@bittery/client-runtime/web";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import type { AttachmentItem, AttachmentUploadErrorCode } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createAttachmentDownloadBuffer } from "@/lib/attachment-download-buffer";
import { attachmentDownloadSinks, attachmentUploadSources } from "@/lib/crypto";
import { observeAccountDeparture } from "@/lib/runtime-account-presentation";
import { useRuntimeMutation } from "./use-runtime-mutation";

export { createAttachmentDownloadBuffer } from "@/lib/attachment-download-buffer";

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
	const downloads = useRef(new Set<AbortController>());
	const owner = useMemo(() => ({ accountId, itemId }), [accountId, itemId]);
	const displayedOwner = useRef(owner);
	displayedOwner.current = owner;
	const mounted = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Replacing the displayed Item retires its foreground downloads.
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			for (const download of downloads.current) download.abort();
			downloads.current.clear();
		};
	}, [owner]);

	const upload = useRuntimeMutation({
		accountId: () => accountId,
		mutationFn: async (file: File & { displayName?: string }, signal) => {
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
			return runtime.uploadAttachment(
				{
					accountId,
					itemId,
					name,
					contentType,
					fileSize: String(file.size),
					sourceCapabilityId,
				},
				{ signal },
			);
		},
	});

	const download = useCallback(
		async (attachment: AttachmentItem) => {
			if (!mounted.current || displayedOwner.current !== owner)
				throw new DOMException("Download presentation detached", "AbortError");
			if (!accountId || !itemId || attachment.itemId !== itemId)
				throw new Error("Runtime Item authority is unavailable");
			if (!attachment.name)
				throw new Error("Runtime Attachment name is unavailable");
			const attempt = new AbortController();
			downloads.current.add(attempt);
			const release = observeAccountDeparture(runtime, accountId, () =>
				attempt.abort(),
			);
			const sink = createAttachmentDownloadBuffer(attachment.fileSize);
			try {
				attempt.signal.throwIfAborted();
				const sinkCapabilityId = attachmentDownloadSinks.grant({
					accountId,
					attachmentId: attachment.id,
					sink,
				});
				await runtime.downloadAttachment(
					{ accountId, attachmentId: attachment.id, sinkCapabilityId },
					{ signal: attempt.signal },
				);
				attempt.signal.throwIfAborted();
				return { bytes: sink.take(), fileName: attachment.name };
			} catch (error) {
				await sink.discard();
				throw error;
			} finally {
				release();
				downloads.current.delete(attempt);
			}
		},
		[runtime, accountId, itemId, owner],
	);

	const rename = useRuntimeMutation({
		accountId: () => accountId,
		mutationFn: (
			{ attachmentId, newName }: { attachmentId: string; newName: string },
			signal,
		) => {
			if (!accountId)
				throw new Error("Runtime Account authority is unavailable");
			return runtime.renameAttachment(
				{
					accountId,
					attachmentId,
					name: newName,
				},
				{ signal },
			);
		},
	});
	const remove = useRuntimeMutation({
		accountId: () => accountId,
		mutationFn: (attachmentId: string, signal) => {
			if (!accountId)
				throw new Error("Runtime Account authority is unavailable");
			return runtime.deleteAttachment({ accountId, attachmentId }, { signal });
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
		// Foreground plaintext goes to the caller, never into a mutation cache.
		download: { mutateAsync: download },
		rename,
		remove,
	};
}
