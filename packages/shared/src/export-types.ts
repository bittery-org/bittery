/**
 * Types for encrypted vault export/import
 */

import type { DecryptedItem, ItemCategory } from "./types";

/**
 * Vault metadata in the export
 */
export interface ExportedVault {
	id: string;
	name: string;
	type: "personal" | "team";
	icon?: string;
	items: ExportedItem[];
}

/**
 * Item data in the export (decrypted)
 */
export interface ExportedItem {
	id: string;
	category: ItemCategory;
	favorite: boolean;
	data: Omit<
		DecryptedItem,
		"id" | "vaultId" | "category" | "favorite" | "createdAt" | "updatedAt"
	>;
	createdAt: string;
	updatedAt: string;
}

/**
 * Complete export payload (before encryption)
 */
export interface VaultExportPayload {
	version: string;
	exportDate: string;
	exportedBy: {
		email: string;
		name?: string;
	};
	vaults: ExportedVault[];
	metadata: {
		totalItems: number;
		totalVaults: number;
	};
}

/**
 * Final encrypted export file format
 */
export interface EncryptedVaultExport {
	format: "bittery-encrypted-export";
	version: string;
	exportDate: string;
	encryption: {
		version: string;
		algorithm: string;
		iterations: number;
		salt: string;
		iv: string;
		ciphertext: string;
	};
}
