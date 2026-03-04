import type { DecryptedItemData, ItemCategory } from "../types";

/**
 * Import providers currently supported by the shared import domain.
 * Keep as a strict union so future providers are added intentionally.
 */
export type ImportProviderId = "1password-1pux";

export type ImportMessageValue = string | number;

export type ImportMessageParams = Record<string, ImportMessageValue>;

export type ImportWarningCode =
	| "item-parse-failed"
	| "invalid-item"
	| "archived-skipped"
	| "missing-title"
	| "documents-skipped"
	| "attachments-skipped"
	| "category-fallback"
	| "totp-secret-missing";

export interface ImportWarning {
	code: ImportWarningCode;
	params?: ImportMessageParams;
	sourceVaultId?: string;
	sourceItemId?: string;
}

export type ImportErrorCode =
	| "unsupported-file-type"
	| "archive-read-failed"
	| "missing-export-data"
	| "read-export-data-failed"
	| "invalid-export-data-json"
	| "no-vaults-found"
	| "unsupported-item-provider";

export class ImportProviderError extends Error {
	readonly code: ImportErrorCode;
	readonly params?: ImportMessageParams;

	constructor(code: ImportErrorCode, params?: ImportMessageParams) {
		super(code);
		this.name = "ImportProviderError";
		this.code = code;
		this.params = params;
	}
}

export interface ImportError {
	code: ImportErrorCode;
	params?: ImportMessageParams;
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
