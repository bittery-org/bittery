import type { DecryptedItemData } from "@bittery/shared/types";
import { buildColumnIndex, parseCsv, readCsvColumn } from "../csv";
import { normalizeUrl } from "../normalize";
import type {
	ImportDecryptedItem,
	ImportPreview,
	ImportProvider,
	ImportSourceItem,
	ImportSourceVault,
	ImportWarning,
} from "../types";
import { ImportProviderError } from "../types";

/**
 * Column layouts Chrome/Chromium is known to write, each pinned to a fixture in
 * `__tests__/fixtures/chrome`. Matching is exact and ordered: Chromium's
 * exporter writes a fixed column order (`password_csv_writer.cc`), so a header
 * that is merely similar is a file shape we have never seen and must not guess
 * at. Widen this list only together with a new pinned fixture.
 */
const HEADER_VARIANTS: readonly (readonly string[])[] = [
	// Current Chromium.
	["name", "url", "username", "password", "note"],
	// Older exports, written before the `note` column existed.
	["name", "url", "username", "password"],
];

/** Chrome has no folders, so every item lands in one synthetic source vault. */
const SOURCE_VAULT_ID = "chrome-passwords";

/** Fallback name; the app layer replaces it via `nameCode`. */
const SOURCE_VAULT_NAME = "Chrome Passwords";

/**
 * `android://<hash>@<package>` facet URI, written for Android app credentials.
 * The trailing slash is present in some exports and absent in others.
 */
const ANDROID_FACET_PATTERN = /^android:\/\/[^@]+@([^/]+)\/?$/i;

export const chromeImportProvider: ImportProvider = {
	id: "chrome",
	title: "Chrome",
	description: "Unencrypted .csv export",
	imageDescription: "Chrome logo",
	accentColor: "#4285F4",
	fileAccept: ".csv",
	fileTypeLabel: ".csv",

	canParse(file: File): boolean {
		return file.name.toLowerCase().endsWith(".csv");
	},

	async parse(file: File): Promise<ImportPreview> {
		if (!chromeImportProvider.canParse(file)) {
			throw new ImportProviderError("unsupported-file-type", {
				format: chromeImportProvider.fileTypeLabel,
			});
		}

		let text: string;
		try {
			text = await file.text();
		} catch {
			throw new ImportProviderError("read-export-data-failed");
		}

		return parseCsvExport(text);
	},

	toDecryptedItemData(sourceItem: ImportSourceItem): ImportDecryptedItem {
		if (sourceItem.providerId !== chromeImportProvider.id) {
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

function parseCsvExport(text: string): ImportPreview {
	// The whole file is tokenized and structurally validated up front, then the
	// header layout is matched against a pinned variant. Both happen before a
	// single item is built, so an unrecognized export can never produce a
	// partial preview.
	const table = parseCsv(text, { requiredHeaders: [] });
	assertKnownHeaderVariant(table.headers);

	if (table.rows.length === 0) {
		throw new ImportProviderError("no-items-found");
	}

	const columns = buildColumnIndex(table.headers);
	const warnings: ImportWarning[] = [];
	const sourceItems: ImportSourceItem[] = [];

	table.rows.forEach((row, index) => {
		// Row 1 is the header, so the first data row is row 2.
		const rowNumber = index + 2;
		const itemId = `chrome-row-${rowNumber}`;

		const rawUrl = readCsvColumn(row, columns, "url").trim();
		// `android://…` already carries a scheme, so it survives normalization
		// verbatim. Bittery cannot open it, but rewriting it would invent a URL
		// the export never contained.
		const url = normalizeUrl(rawUrl);

		const rawTitle = readCsvColumn(row, columns, "name").trim();
		// Android rows can ship an empty `name`; the package name inside the
		// facet URI is then the only human-readable label in the row.
		const androidPackage = readAndroidPackage(rawUrl);
		const title = rawTitle || androidPackage || `Imported item ${index + 1}`;

		if (!rawTitle && !androidPackage) {
			warnings.push({
				code: "missing-title",
				params: {
					itemNumber: index + 1,
					vaultName: SOURCE_VAULT_NAME,
					title,
				},
				sourceVaultId: SOURCE_VAULT_ID,
				sourceItemId: itemId,
			});
		}

		const username = readCsvColumn(row, columns, "username").trim();
		const password = readCsvColumn(row, columns, "password");
		// Absent in the older four-column layout, where this reads as empty.
		const notes = readCsvColumn(row, columns, "note");

		const data: DecryptedItemData = {
			title,
			...(url ? { url, urls: [url] } : {}),
			...(username ? { username } : {}),
			...(password ? { password } : {}),
			...(notes ? { notes } : {}),
		};

		sourceItems.push({
			providerId: chromeImportProvider.id,
			id: itemId,
			sourceVaultId: SOURCE_VAULT_ID,
			title,
			// Chrome exports login data only; there is no type column to read.
			sourceCategory: "login",
			category: "login",
			favorite: false,
			data,
		});
	});

	const sourceVault: ImportSourceVault = {
		id: SOURCE_VAULT_ID,
		name: SOURCE_VAULT_NAME,
		nameCode: "chrome-passwords",
		itemCount: sourceItems.length,
		skippedCount: 0,
	};

	return {
		providerId: chromeImportProvider.id,
		sourceVaults: [sourceVault],
		sourceItems,
		warnings,
		errors: [],
		summary: {
			vaultCount: 1,
			itemCount: sourceItems.length,
			skippedCount: 0,
			warningCount: warnings.length,
			errorCount: 0,
		},
	};
}

function assertKnownHeaderVariant(headers: string[]): void {
	const actual = headers.map((header) => header.trim().toLowerCase());
	const matches = HEADER_VARIANTS.some(
		(variant) =>
			variant.length === actual.length &&
			variant.every((header, index) => header === actual[index]),
	);

	if (matches) {
		return;
	}

	throw new ImportProviderError("csv-unknown-header-variant", {
		headers: headers.join(","),
		expected: HEADER_VARIANTS.map((variant) => variant.join(",")).join(" | "),
	});
}

function readAndroidPackage(rawUrl: string): string | null {
	const match = rawUrl.match(ANDROID_FACET_PATTERN);
	return match?.[1] ?? null;
}
