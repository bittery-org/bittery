/**
 * Types for encrypted vault export/import
 */

import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";

/**
 * Vault metadata in the export (items stored flat at the top level)
 */
export interface ExportedVault {
	id: string;
	name: string;
	type: "personal" | "team";
	icon?: string | null;
}

/**
 * Attachment data in the export (decrypted, base64-encoded)
 */
export interface ExportedAttachment {
	filename: string;
	contentType: string;
	data: string; // base64
}

/**
 * Item data in the export (decrypted, flat — vaultId links back to ExportedVault)
 */
export interface ExportedItem {
	id: string;
	vaultId: string;
	category: ItemCategory;
	favorite: boolean;
	data: DecryptedItemData;
	attachments?: ExportedAttachment[];
	createdAt: string;
	updatedAt: string;
}

/**
 * Complete export payload
 */
export interface VaultExportPayload {
	version: string;
	exportDate: string;
	exportedBy: {
		email: string;
		name?: string;
	};
	vaults: ExportedVault[];
	items: ExportedItem[];
	metadata: {
		totalItems: number;
		totalVaults: number;
	};
}
