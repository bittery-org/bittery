import { RuntimeRequestError } from "@bittery/client-runtime/client";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import type { AtomicAttachmentUploadSource } from "@bittery/client-runtime/web";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import type { AttachmentItem, AttachmentUploadErrorCode } from "@bittery/ui";
import {
	observeAccountDeparture,
	useRuntimeMutation,
} from "@bittery/ui/runtime-presentation";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { createAttachmentDownloadBuffer } from "@/lib/attachment-download-buffer";
import { attachmentDownloadSinks, attachmentUploadSources } from "@/lib/crypto";

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
	vaultId: string;
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
	const vaultId = item?.vaultId;
	const downloads = useRef(new Set<AbortController>());
	const owner = useMemo(
		() => ({ accountId, itemId, vaultId }),
		[accountId, itemId, vaultId],
	);
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

	const uploadMutation = useRuntimeMutation({
		accountId: () => accountId,
		mutationFn: async (
			{
				file,
				scope,
			}: {
				file: File & { displayName?: string };
				scope: ReturnType<typeof attachmentUploadSources.captureScope>;
			},
			signal,
		) => {
			if (!accountId || !itemId || !vaultId)
				throw new Error("Runtime Item authority is unavailable");
			const name = file.displayName?.trim() || file.name;
			const contentType = file.type.trim() || "application/octet-stream";
			const sourceCapabilityId = attachmentUploadSources.grant({
				scope,
				vaultId,
				accountId,
				itemId,
				name,
				contentType,
				expectedBytes: BigInt(file.size),
				source: createFileAttachmentUploadSource(file),
			});
			try {
				return await runtime.uploadAttachment(
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
			} finally {
				await attachmentUploadSources.release(sourceCapabilityId);
			}
		},
	});

	const prepareUpload = () => {
		if (
			!mounted.current ||
			displayedOwner.current !== owner ||
			!accountId ||
			!vaultId
		)
			throw new DOMException("Upload presentation detached", "AbortError");
		const scope = attachmentUploadSources.captureScope(accountId, vaultId);
		return (file: File & { displayName?: string }) => {
			if (!mounted.current || displayedOwner.current !== owner)
				throw new DOMException("Upload presentation detached", "AbortError");
			return uploadMutation.mutateAsync({ file, scope });
		};
	};
	const upload = {
		mutateAsync: (file: File & { displayName?: string }) =>
			prepareUpload()(file),
	};

	const download = useCallback(
		async (attachment: AttachmentItem) => {
			if (!mounted.current || displayedOwner.current !== owner)
				throw new DOMException("Download presentation detached", "AbortError");
			if (
				!accountId ||
				!itemId ||
				!vaultId ||
				attachment.itemId !== itemId ||
				attachment.vaultId !== vaultId
			)
				throw new Error("Runtime Item authority is unavailable");
			if (!attachment.name)
				throw new Error("Runtime Attachment name is unavailable");
			const scope = attachmentDownloadSinks.captureScope(accountId, vaultId);
			const attempt = new AbortController();
			downloads.current.add(attempt);
			const release = observeAccountDeparture(runtime, accountId, () =>
				attempt.abort(),
			);
			const sink = createAttachmentDownloadBuffer(attachment.fileSize);
			let sinkCapabilityId: string | undefined;
			try {
				attempt.signal.throwIfAborted();
				sinkCapabilityId = attachmentDownloadSinks.grant({
					scope,
					vaultId,
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
				try {
					if (sinkCapabilityId !== undefined)
						await attachmentDownloadSinks.release(sinkCapabilityId);
				} finally {
					release();
					downloads.current.delete(attempt);
				}
			}
		},
		[runtime, accountId, itemId, vaultId, owner],
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
		prepareUpload,
		// Foreground plaintext goes to the caller, never into a mutation cache.
		download: { mutateAsync: download },
		rename,
		remove,
	};
}
