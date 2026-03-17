import JSZip from "jszip";
import type { VaultExportPayload } from "../../export-types";
import type {
	ImportDecryptedItem,
	ImportPreview,
	ImportProvider,
	ImportSourceItem,
	ImportSourceVault,
	ImportWarning,
} from "../types";
import { ImportProviderError } from "../types";

export const bitteryBttrxImportProvider: ImportProvider = {
	id: "bittery-bttrx",
	title: "Bittery",
	description: ".bttrx vault export",
	imageDescription: "Bittery logo",
	accentColor: "#6366F1",
	fileAccept: ".bttrx",
	fileTypeLabel: ".bttrx",

	canParse(file: File): boolean {
		return file.name.toLowerCase().endsWith(".bttrx");
	},

	async parse(file: File): Promise<ImportPreview> {
		if (!bitteryBttrxImportProvider.canParse(file)) {
			throw new ImportProviderError("unsupported-file-type");
		}

		let archiveBuffer: ArrayBuffer;
		try {
			archiveBuffer = await file.arrayBuffer();
		} catch {
			throw new ImportProviderError("archive-read-failed");
		}

		let archive: JSZip;
		try {
			archive = await JSZip.loadAsync(archiveBuffer);
		} catch {
			throw new ImportProviderError("archive-read-failed");
		}

		const exportJsonEntry = archive.file("export.json");
		if (!exportJsonEntry) {
			throw new ImportProviderError("missing-export-data");
		}

		let exportJsonText: string;
		try {
			exportJsonText = await exportJsonEntry.async("string");
		} catch {
			throw new ImportProviderError("read-export-data-failed");
		}

		let payload: VaultExportPayload;
		try {
			payload = JSON.parse(exportJsonText) as VaultExportPayload;
		} catch {
			throw new ImportProviderError("invalid-export-data-json");
		}

		if (!payload.vaults || payload.vaults.length === 0) {
			throw new ImportProviderError("no-vaults-found");
		}

		const warnings: ImportWarning[] = [];
		const sourceVaults: ImportSourceVault[] = [];
		const sourceItems: ImportSourceItem[] = [];

		// Build a per-vault item count map
		const itemCountByVault = new Map<string, number>();
		for (const item of payload.items ?? []) {
			itemCountByVault.set(
				item.vaultId,
				(itemCountByVault.get(item.vaultId) ?? 0) + 1,
			);
		}

		for (const vault of payload.vaults) {
			sourceVaults.push({
				id: vault.id,
				name: vault.name,
				itemCount: itemCountByVault.get(vault.id) ?? 0,
				skippedCount: 0,
			});
		}

		for (const item of payload.items ?? []) {
			const title = item.data?.title || "(no title)";

			// Warn about attachments that will not be re-uploaded in v1
			if (item.attachments && item.attachments.length > 0) {
				warnings.push({
					code: "attachments-skipped",
					params: { title },
					sourceVaultId: item.vaultId,
					sourceItemId: item.id,
				});
			}

			sourceItems.push({
				providerId: bitteryBttrxImportProvider.id,
				id: item.id,
				sourceVaultId: item.vaultId,
				title,
				category: item.category,
				favorite: item.favorite ?? false,
				data: item.data,
			});
		}

		const skippedCount = 0;

		return {
			providerId: bitteryBttrxImportProvider.id,
			sourceVaults,
			sourceItems,
			warnings,
			errors: [],
			summary: {
				vaultCount: sourceVaults.length,
				itemCount: sourceItems.length,
				skippedCount,
				warningCount: warnings.length,
				errorCount: 0,
			},
		};
	},

	toDecryptedItemData(sourceItem: ImportSourceItem): ImportDecryptedItem {
		if (sourceItem.providerId !== bitteryBttrxImportProvider.id) {
			throw new ImportProviderError("unsupported-item-provider", {
				providerId: sourceItem.providerId,
			});
		}

		return {
			category: sourceItem.category,
			data: sourceItem.data,
			favorite: sourceItem.favorite ?? false,
		};
	},
};
