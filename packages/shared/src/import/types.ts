import type { DecryptedItemData, ItemCategory } from "../types";

/**
 * Import providers currently supported by the shared import domain.
 * Keep as a strict union so future providers are added intentionally.
 */
export type ImportProviderId = "1password-1pux";

export interface ImportWarning {
	code: string;
	message: string;
	sourceVaultId?: string;
	sourceItemId?: string;
}

export interface ImportError {
	code: string;
	message: string;
	sourceVaultId?: string;
	sourceItemId?: string;
}

export interface ImportSourceVault {
	id: string;
	name: string;
	itemCount: number;
	skippedCount: number;
}

export interface ImportSourceItem {
	providerId: ImportProviderId;
	id: string;
	sourceVaultId: string;
	title: string;
	sourceCategory?: string;
	category: ItemCategory;
	favorite: boolean;
	data: DecryptedItemData;
}

export interface ImportPreviewSummary {
	vaultCount: number;
	itemCount: number;
	skippedCount: number;
	warningCount: number;
	errorCount: number;
}

export interface ImportPreview {
	providerId: ImportProviderId;
	sourceVaults: ImportSourceVault[];
	sourceItems: ImportSourceItem[];
	warnings: ImportWarning[];
	errors: ImportError[];
	summary: ImportPreviewSummary;
}

export interface ImportDecryptedItem {
	category: ItemCategory;
	data: DecryptedItemData;
	favorite: boolean;
}

export interface ImportProvider {
	id: ImportProviderId;
	title: string;
	description: string;
	imageDescription: string;
	accentColor: string;
	fileAccept: string;
	fileTypeLabel: string;
	canParse(file: File): boolean;
	parse(file: File): Promise<ImportPreview>;
	toDecryptedItemData(sourceItem: ImportSourceItem): ImportDecryptedItem;
}
