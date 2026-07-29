import type { DecryptedItemData, ItemCategory } from "../types";

/**
 * Import providers currently supported by the shared import domain.
 * Keep as a strict union so future providers are added intentionally.
 */
export type ImportProviderId = "1password-1pux" | "bittery-bttrx" | "bitwarden";

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
	| "totp-secret-missing"
	| "reprompt-not-supported"
	| "unsupported-item-type"
	| "passkeys-skipped"
	| "linked-field-skipped";

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
	| "no-items-found"
	| "unsupported-item-provider"
	| "csv-empty-file"
	| "csv-malformed-quoting"
	| "csv-duplicate-header"
	| "csv-missing-header"
	| "csv-row-column-mismatch"
	| "bitwarden-encrypted-export-unsupported"
	| "bitwarden-attachment-export-unsupported"
	| "bitwarden-organization-export-unsupported";

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

/**
 * Localizable names a provider can request for a synthetic source vault.
 * Providers live in `@bittery/shared` and have no i18n access, so they emit a
 * code and the app layer resolves it to a translated string.
 */
export type ImportSourceVaultNameCode = "no-folder";

export interface ImportSourceVault {
	id: string;
	name: string;
	nameCode?: ImportSourceVaultNameCode;
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
