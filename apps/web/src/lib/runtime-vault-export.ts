import type { RuntimeClient } from "@bittery/client-runtime/client";
import type { AttachmentDownloadSinkGrants } from "@bittery/client-runtime/web";
import type { DecryptedItemData } from "@bittery/shared/types";
import JSZip from "jszip";
import { createAttachmentDownloadBuffer } from "./attachment-download-buffer";
import type {
	ExportedItem,
	ExportedVault,
	VaultExportPayload,
} from "./export-types";
import { observeAccountDeparture } from "./runtime-account-presentation";

export type ExportStage =
	| "idle"
	| "fetching"
	| "decrypting"
	| "downloading-files"
	| "building-archive"
	| "completed"
	| "error";
export interface ExportProgress {
	stage: ExportStage;
	totalItems: number;
	processedItems: number;
	totalAttachments: number;
	processedAttachments: number;
	currentVaultName?: string;
}

/** Formats Runtime's unlocked view; authority, keys and authenticated transfers stay in Runtime. */
export async function createRuntimeVaultArchive(
	runtime: RuntimeClient,
	sinks: AttachmentDownloadSinkGrants,
	report: (progress: ExportProgress) => void,
	signal: AbortSignal,
): Promise<Blob> {
	const session = runtime.session().getSnapshot();
	if (session.state !== "unlocked" || !session.accountId)
		throw new Error("Unlock an Account before exporting");
	const accountId = session.accountId;
	const identity = session.accounts.find(
		(account) => account.accountId === accountId,
	)?.displayIdentity;
	if (!identity) throw new Error("Runtime Account identity is unavailable");
	const snapshot = runtime.items(accountId).getSnapshot();
	if (snapshot.state !== "ready" || snapshot.value.accountId !== accountId)
		throw new Error("Runtime Items are not ready for export");
	const projection = snapshot.value;
	const attempt = new AbortController();
	const abort = () => attempt.abort(signal.reason);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	let release = () => {};
	try {
		// Latch every observed departure. Returning to the same unlocked Account never revives this attempt.
		release = observeAccountDeparture(runtime, accountId, () => {
			attempt.abort(
				new DOMException("The export Account changed or locked", "AbortError"),
			);
		});
		const assertActive = () => attempt.signal.throwIfAborted();
		assertActive();
		const items = projection.items.filter((item) => !item.deletedAt);
		const vaultIds = new Set(items.map((item) => item.vaultId));
		const vaults: ExportedVault[] = projection.vaults
			.filter((vault) => vaultIds.has(vault.vaultId))
			.map((vault) => ({
				id: vault.vaultId,
				name: vault.name,
				type: vault.vaultType,
				icon: vault.icon ?? null,
			}));
		if (vaults.length !== vaultIds.size)
			throw new Error("Runtime Vault metadata is unavailable");
		const progress: ExportProgress = {
			stage: "downloading-files",
			totalItems: items.length,
			processedItems: items.length,
			totalAttachments: items.reduce(
				(count, item) => count + (item.attachments?.length ?? 0),
				0,
			),
			processedAttachments: 0,
		};
		report({ ...progress });
		const zip = new JSZip();
		const exportedItems: ExportedItem[] = [];
		for (const item of items) {
			assertActive();
			const exported: ExportedItem = {
				id: item.itemId,
				vaultId: item.vaultId,
				category:
					item.data.category === "authenticator" ? "totp" : item.data.category,
				favorite: item.favorite,
				data: item.data.data as DecryptedItemData,
				attachments: [],
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			};
			for (const attachment of item.attachments ?? []) {
				assertActive();
				const sink = createAttachmentDownloadBuffer(attachment.fileSize);
				try {
					const sinkCapabilityId = sinks.grant({
						accountId,
						attachmentId: attachment.attachmentId,
						sink,
					});
					await runtime.downloadAttachment(
						{
							accountId,
							attachmentId: attachment.attachmentId,
							sinkCapabilityId,
						},
						{ signal: attempt.signal },
					);
					assertActive();
					const bytes = sink.take();
					// ZIP consumes the owned authenticated bytes; its binary-string form also preserves the v1 JSON attachment field.
					let binary = "";
					for (let offset = 0; offset < bytes.length; offset += 8192)
						binary += String.fromCharCode(
							...bytes.subarray(offset, offset + 8192),
						);
					zip.file(`files/${item.itemId}/${attachment.name}`, bytes);
					exported.attachments?.push({
						filename: attachment.name,
						contentType: attachment.contentType,
						data: btoa(binary),
					});
				} finally {
					await sink.discard();
				}
				progress.processedAttachments += 1;
				report({ ...progress });
			}
			exportedItems.push(exported);
		}
		assertActive();
		report({ ...progress, stage: "building-archive" });
		const payload: VaultExportPayload = {
			version: "1",
			exportDate: new Date().toISOString(),
			exportedBy: { email: identity.email },
			vaults,
			items: exportedItems,
			metadata: {
				totalItems: exportedItems.length,
				totalVaults: vaults.length,
			},
		};
		zip.file("export.json", JSON.stringify(payload, null, 2));
		const blob = await zip.generateAsync({ type: "blob" });
		assertActive();
		report({ ...progress, stage: "completed" });
		return blob;
	} finally {
		release();
		signal.removeEventListener("abort", abort);
	}
}
