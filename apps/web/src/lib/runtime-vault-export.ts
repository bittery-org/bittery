import type {
	RuntimeClient,
	RuntimeVaultExportHandle,
} from "@bittery/client-runtime/client";
import type { VaultExportProjection } from "@bittery/client-runtime/protocol";
import type { AttachmentDownloadSinkGrants } from "@bittery/client-runtime/web";
import type { DecryptedItemData } from "@bittery/shared/types";
import { observeAccountDeparture } from "@bittery/ui/runtime-presentation";
import JSZip from "jszip";
import { createAttachmentDownloadBuffer } from "./attachment-download-buffer";
import type {
	ExportedItem,
	ExportedVault,
	VaultExportPayload,
} from "./export-types";

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

export interface RuntimeVaultArchive {
	/** Admits and performs one synchronous browser output, then consumes this private capture. */
	download(): Promise<void>;
	dispose(): Promise<void>;
}

const emptyProgress = (): ExportProgress => ({
	stage: "idle",
	totalItems: 0,
	processedItems: 0,
	totalAttachments: 0,
	processedAttachments: 0,
});

/** One attempt owns the fixed Core capture, builder work and ready output until disposal. */
export async function createRuntimeVaultArchive(
	runtime: RuntimeClient,
	sinks: AttachmentDownloadSinkGrants,
	report: (progress: ExportProgress) => void,
	signal: AbortSignal,
): Promise<RuntimeVaultArchive> {
	signal.throwIfAborted();
	const session = runtime.session().getSnapshot();
	if (session.state !== "unlocked" || !session.accountId)
		throw new Error("Unlock an Account before exporting");
	const accountId = session.accountId;
	const identity = session.accounts.find(
		(account) => account.accountId === accountId,
	)?.displayIdentity;
	if (!identity) throw new Error("Runtime Account identity is unavailable");
	// Inventory chooses scopes only. Its private Item frame is not retained by this attempt.
	const vaultIds = (() => {
		const inventory = runtime.items(accountId).getSnapshot();
		if (inventory.state !== "ready" || inventory.value.accountId !== accountId)
			throw new Error("Runtime Items are not ready for export");
		return inventory.value.vaults.map((vault) => vault.vaultId);
	})();
	const attempt = new AbortController();
	let blob: Blob | undefined;
	let projection: VaultExportProjection | undefined;
	let retired = false;
	let finished = false;
	let release = () => {};
	let captureTask: Promise<RuntimeVaultExportHandle> | undefined;
	let outputTask: Promise<void> | undefined;
	let cleanupTask: Promise<void> | undefined;
	let finishBuilding = () => {};
	const buildingDone = new Promise<void>((resolve) => {
		finishBuilding = resolve;
	});
	let received = () => {};
	let refuse = (_error: unknown) => {};
	// The completion promise carries no plaintext; only this mutable attempt slot owns it.
	const snapshotTask = new Promise<void>((resolve, reject) => {
		received = resolve;
		refuse = reject;
	});
	const receive = (snapshot: VaultExportProjection) => {
		projection = snapshot;
		received();
	};
	void snapshotTask.catch(() => undefined);
	async function releaseCapture() {
		release();
		signal.removeEventListener("abort", abort);
		const capture = await captureTask?.catch(() => undefined);
		await capture?.close();
	}
	function dispose(): Promise<void> {
		if (!retired && !finished) {
			retired = true;
			const reason = new DOMException(
				"The export scope was retired",
				"AbortError",
			);
			attempt.abort(reason);
			refuse(reason);
			blob = undefined;
			report(emptyProgress());
		}
		return cleanup();
	}
	function cleanup(): Promise<void> {
		if (cleanupTask === undefined) {
			cleanupTask = (async () => {
				await buildingDone;
				await outputTask?.catch(() => undefined);
				await releaseCapture();
			})();
			void cleanupTask.catch(() => {
				cleanupTask = undefined;
			});
		}
		return cleanupTask;
	}
	function abort() {
		void dispose().catch(() => undefined);
	}
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	try {
		attempt.signal.throwIfAborted();
		release = observeAccountDeparture(runtime, accountId, abort);
		attempt.signal.throwIfAborted();
		captureTask = runtime.observeVaultExport({ accountId, vaultIds }, receive, {
			onRetired: abort,
		});
		await captureTask;
		await snapshotTask;
		if (!projection) throw new Error("Runtime Export snapshot is unavailable");
		attempt.signal.throwIfAborted();
		blob = await buildArchive(
			runtime,
			sinks,
			accountId,
			identity.email,
			projection,
			report,
			attempt.signal,
		);
		attempt.signal.throwIfAborted();
		return {
			dispose,
			download() {
				if (outputTask !== undefined) return outputTask;
				if (retired || finished || blob === undefined)
					return Promise.reject(
						new DOMException("The export scope was retired", "AbortError"),
					);
				outputTask = (async () => {
					const capture = await captureTask;
					if (!capture)
						throw new Error("Runtime Export capture is unavailable");
					let lease: string | undefined;
					let output: Blob | undefined;
					let url: string | undefined;
					try {
						lease = await capture.beginOutput();
						attempt.signal.throwIfAborted();
						output = blob;
						if (!output)
							throw new DOMException(
								"The export scope was retired",
								"AbortError",
							);
						url = URL.createObjectURL(output);
						const anchor = document.createElement("a");
						anchor.href = url;
						anchor.download = "bittery-export.bttrx";
						anchor.click();
					} finally {
						if (url !== undefined) URL.revokeObjectURL(url);
						output = undefined;
						blob = undefined;
						try {
							if (lease !== undefined) await capture.finishOutput(lease);
						} finally {
							await releaseCapture();
							finished = true;
						}
					}
				})();
				return outputTask;
			},
		};
	} catch (error) {
		projection = undefined;
		blob = undefined;
		finishBuilding();
		await cleanup();
		throw error;
	} finally {
		projection = undefined;
		finishBuilding();
	}
}

async function buildArchive(
	runtime: RuntimeClient,
	sinks: AttachmentDownloadSinkGrants,
	accountId: string,
	email: string,
	projection: VaultExportProjection,
	report: (progress: ExportProgress) => void,
	signal: AbortSignal,
): Promise<Blob> {
	const assertActive = () => signal.throwIfAborted();
	const zip = new JSZip();
	const exportedItems: ExportedItem[] = [];
	const ownedBuffers: Uint8Array[] = [];
	try {
		const items = projection.items.filter((item) => !item.deletedAt);
		const vaultIds = new Set(items.map((item) => item.vaultId));
		const scopes = new Map(
			[...vaultIds].map((vaultId) => [
				vaultId,
				sinks.captureScope(accountId, vaultId),
			]),
		);
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
				const scope = scopes.get(item.vaultId);
				if (
					!scope ||
					attachment.vaultId !== item.vaultId ||
					attachment.itemId !== item.itemId
				)
					throw new Error("Runtime Attachment authority is unavailable");
				const sink = createAttachmentDownloadBuffer(attachment.fileSize);
				let sinkCapabilityId: string | undefined;
				try {
					sinkCapabilityId = sinks.grant({
						scope,
						vaultId: item.vaultId,
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
						{ signal: signal },
					);
					assertActive();
					const bytes = sink.take();
					ownedBuffers.push(bytes);
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
					try {
						if (sinkCapabilityId !== undefined)
							await sinks.release(sinkCapabilityId);
					} finally {
						await sink.discard();
					}
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
			exportedBy: { email },
			vaults,
			items: exportedItems,
			metadata: {
				totalItems: exportedItems.length,
				totalVaults: vaults.length,
			},
		};
		zip.file("export.json", JSON.stringify(payload, null, 2));
		const blob = await zip.generateAsync({ type: "blob" }, assertActive);
		assertActive();
		report({ ...progress, stage: "completed" });
		return blob;
	} finally {
		for (const bytes of ownedBuffers) bytes.fill(0);
		ownedBuffers.length = 0;
		exportedItems.length = 0;
		for (const name of Object.keys(zip.files)) zip.remove(name);
	}
}
