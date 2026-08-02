import {
	buildAttachmentBlobEncryptionContext,
	buildAttachmentContentTypeEncryptionContext,
	buildAttachmentNameEncryptionContext,
} from "@bittery/core/services/encryption-context";
import {
	type ExportedAttachment,
	type ExportedItem,
	type ExportedVault,
	getDecryptedVaultKey,
	type VaultExportPayload,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { useRPCClient } from "@bittery/shared/rpc";
import { toCachedVaultFields } from "@bittery/shared/vault-mapping";
import JSZip from "jszip";
import { useCallback, useState } from "react";
import { normalizeItemCategory } from "@/lib/rpc-normalizers";
import { storage } from "@/lib/storage";
import { decrypt, rsaDecrypt } from "@/lib/wasm-crypto";

const vaultKeyCrypto: VaultKeyCryptoProvider = {
	decrypt,
	rsaDecrypt,
};

function normalizeVersion(version: number): number {
	if (!Number.isFinite(version) || version < 1) {
		return 1;
	}
	return Math.floor(version);
}

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

function createEmptyProgress(): ExportProgress {
	return {
		stage: "idle",
		totalItems: 0,
		processedItems: 0,
		totalAttachments: 0,
		processedAttachments: 0,
	};
}

export function useVaultExport() {
	const rpcClient = useRPCClient();

	const [progress, setProgress] = useState<ExportProgress>(
		createEmptyProgress(),
	);
	const [archiveBlob, setArchiveBlob] = useState<Blob | null>(null);
	const [error, setError] = useState<string | null>(null);

	const reset = useCallback(() => {
		setProgress(createEmptyProgress());
		setArchiveBlob(null);
		setError(null);
	}, []);

	const startExport = useCallback(async () => {
		setArchiveBlob(null);
		setError(null);

		try {
			// ── Stage 1: fetch ─────────────────────────────────────────────
			setProgress({
				stage: "fetching",
				totalItems: 0,
				processedItems: 0,
				totalAttachments: 0,
				processedAttachments: 0,
			});

			const allItems = await rpcClient.vault.listAllItems.query();
			const me = await rpcClient.auth.me.query();

			// Collect unique vaults
			const vaultMap = new Map<
				string,
				{
					id: string;
					name: string;
					type: "personal" | "team";
					icon: string | null;
				}
			>();
			for (const item of allItems) {
				if (!vaultMap.has(item.vaultId)) {
					const vaultRecord = item.vault;
					const vault = vaultRecord
						? toCachedVaultFields(vaultRecord)
						: undefined;
					vaultMap.set(item.vaultId, {
						id: vault?.id ?? item.vaultId,
						name: vault?.name ?? item.vaultId,
						type: vault?.type ?? "personal",
						icon: vault?.icon ?? null,
					});
				}
			}

			const totalAttachments = allItems.reduce(
				(sum, item) => sum + (item.attachments?.length ?? 0),
				0,
			);

			// ── Stage 2: decrypt items ─────────────────────────────────────
			setProgress({
				stage: "decrypting",
				totalItems: allItems.length,
				processedItems: 0,
				totalAttachments,
				processedAttachments: 0,
			});

			// Get fallback userId for encryption context
			const fallbackUserId =
				(await storage.getActiveAccountUserId()) ?? me?.id ?? "";

			// Build vault key map
			const vaultKeyCache = new Map<string, Uint8Array>();
			for (const vaultId of vaultMap.keys()) {
				const key = await getDecryptedVaultKey({
					vaultId,
					storage,
					crypto: vaultKeyCrypto,
				});
				if (key) {
					vaultKeyCache.set(vaultId, key);
				}
			}

			const exportedItems: ExportedItem[] = [];

			for (let i = 0; i < allItems.length; i++) {
				const item = allItems[i];
				const vaultKey = vaultKeyCache.get(item.vaultId);
				if (!vaultKey) {
					setProgress((prev) => ({
						...prev,
						processedItems: i + 1,
					}));
					continue;
				}

				const contextUserId = item.lastModifiedBy ?? fallbackUserId;
				const storedVersion = normalizeVersion(item.version ?? 1);
				let decryptedStr: string | null = null;

				for (let ver = storedVersion; ver >= 1; ver--) {
					try {
						decryptedStr = await decrypt(
							{
								ciphertext: item.encryptedData,
								iv: item.encryptionIv,
								algorithm: item.encryptionAlgorithm,
							},
							vaultKey,
							{
								vaultId: item.vaultId,
								entityId: item.id,
								entityType: "item",
								version: ver,
								userId: contextUserId,
							},
						);
						break;
					} catch {
						// try next version
					}
				}

				if (decryptedStr) {
					exportedItems.push({
						id: item.id,
						vaultId: item.vaultId,
						category: normalizeItemCategory(item.category),
						favorite: item.favorite,
						data: JSON.parse(decryptedStr),
						attachments: [],
						createdAt: String(item.createdAt),
						updatedAt: String(item.updatedAt),
					});
				}

				setProgress((prev) => ({
					...prev,
					processedItems: i + 1,
				}));
			}

			// ── Stage 3: download attachments ──────────────────────────────
			setProgress((prev) => ({
				...prev,
				stage: "downloading-files",
			}));

			const zip = new JSZip();
			let processedAttachments = 0;

			for (const item of allItems) {
				if (!item.attachments || item.attachments.length === 0) {
					continue;
				}
				const vaultKey = vaultKeyCache.get(item.vaultId);
				if (!vaultKey) {
					continue;
				}
				const exportedItem = exportedItems.find((ei) => ei.id === item.id);

				for (const attachment of item.attachments) {
					try {
						const contextUserId = attachment.uploadedBy ?? fallbackUserId;

						const blobContext = buildAttachmentBlobEncryptionContext({
							vaultId: item.vaultId,
							attachmentKey: attachment.storageKey,
							userId: contextUserId,
						});
						const nameContext = buildAttachmentNameEncryptionContext({
							vaultId: item.vaultId,
							attachmentKey: attachment.storageKey,
							userId: contextUserId,
						});
						const contentTypeContext =
							buildAttachmentContentTypeEncryptionContext({
								vaultId: item.vaultId,
								attachmentKey: attachment.storageKey,
								userId: contextUserId,
							});

						const {
							downloadUrl,
							encryptionIv,
							encryptionAlgorithm,
							encryptedName,
							encryptedContentType,
							encryptedContentTypeIv,
						} = await rpcClient.vault.getAttachmentDownloadUrl.mutate({
							attachmentId: attachment.id,
						});

						const response = await fetch(downloadUrl);
						if (!response.ok) {
							throw new Error("Failed to download attachment");
						}
						const encryptedJson = await response.text();
						const encryptedFile = JSON.parse(encryptedJson) as {
							ciphertext: string;
							iv: string;
							algorithm: string;
						};

						const base64File = await decrypt(
							encryptedFile,
							vaultKey,
							blobContext,
						);

						const fileName = await decrypt(
							{
								ciphertext: encryptedName,
								iv: encryptionIv,
								algorithm: encryptionAlgorithm,
							},
							vaultKey,
							nameContext,
						);

						const contentType = await decrypt(
							{
								ciphertext: encryptedContentType,
								iv: encryptedContentTypeIv ?? encryptionIv,
								algorithm: encryptionAlgorithm,
							},
							vaultKey,
							contentTypeContext,
						);

						// Convert base64 to bytes for the ZIP entry
						const binaryString = atob(base64File);
						const bytes = new Uint8Array(binaryString.length);
						for (let i = 0; i < binaryString.length; i++) {
							bytes[i] = binaryString.charCodeAt(i);
						}

						zip.file(`files/${item.id}/${fileName}`, bytes);

						if (exportedItem) {
							if (!exportedItem.attachments) {
								exportedItem.attachments = [];
							}
							exportedItem.attachments.push({
								filename: fileName,
								contentType,
								data: base64File,
							} satisfies ExportedAttachment);
						}
					} catch {
						// skip failed attachment, continue with others
					}

					processedAttachments += 1;
					setProgress((prev) => ({
						...prev,
						processedAttachments,
					}));
				}
			}

			// ── Stage 4: build archive ─────────────────────────────────────
			setProgress((prev) => ({
				...prev,
				stage: "building-archive",
			}));

			const exportedVaults: ExportedVault[] = [...vaultMap.values()];
			const payload: VaultExportPayload = {
				version: "1",
				exportDate: new Date().toISOString(),
				exportedBy: {
					email: me?.email ?? "",
					name: me?.name ?? undefined,
				},
				vaults: exportedVaults,
				items: exportedItems,
				metadata: {
					totalItems: exportedItems.length,
					totalVaults: exportedVaults.length,
				},
			};

			zip.file("export.json", JSON.stringify(payload, null, 2));
			const blob = await zip.generateAsync({ type: "blob" });

			setArchiveBlob(blob);
			setProgress((prev) => ({
				...prev,
				stage: "completed",
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			setProgress((prev) => ({
				...prev,
				stage: "error",
			}));
		}
	}, [rpcClient]);

	const downloadArchive = useCallback(() => {
		if (!archiveBlob) return;
		const url = URL.createObjectURL(archiveBlob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bittery-export.bttrx";
		a.click();
		URL.revokeObjectURL(url);
	}, [archiveBlob]);

	return {
		progress,
		archiveBlob,
		error,
		reset,
		startExport,
		downloadArchive,
	};
}
