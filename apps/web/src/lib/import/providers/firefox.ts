import type { CustomField, DecryptedItemData } from "@bittery/shared/types";
import { buildColumnIndex, parseCsv, readCsvColumn } from "../csv";
import { buildCustomFieldId, normalizeUrl } from "../normalize";
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
 * Exact column set written by Firefox's desktop exporter, in order.
 *
 * Pinned from `toolkit/components/passwordmgr/LoginExport.sys.mjs`, whose unit
 * test asserts the header verbatim. `url` is the only renamed column — the
 * login property behind it is `origin`.
 *
 * All nine are required: Firefox has written exactly these since the exporter
 * shipped, and accepting a subset would let a Chrome or KeePass CSV through to
 * a mapping that silently loses columns. Extra columns are tolerated so a
 * future Firefox release that appends one still imports.
 */
const CSV_REQUIRED_HEADERS = [
	"url",
	"username",
	"password",
	"httpRealm",
	"formActionOrigin",
	"guid",
	"timeCreated",
	"timeLastUsed",
	"timePasswordChanged",
];

/**
 * Firefox has no folders, so every item lands in one synthetic source vault.
 * The name is the product's, not a translated string.
 */
const SOURCE_VAULT_ID = "firefox-logins";
const SOURCE_VAULT_NAME = "Firefox";

/**
 * Origin of the Firefox Sync account entry. Every export taken from a
 * Sync-signed-in profile carries this row, and its "password" is a JSON blob of
 * sync keys rather than a credential.
 */
const SYNC_ACCOUNT_ORIGIN = "chrome://firefoxaccounts";

/** Label for the custom field carrying an HTTP-auth login's realm. */
const HTTP_REALM_FIELD_LABEL = "HTTP Realm";

export const firefoxImportProvider: ImportProvider = {
	id: "firefox",
	title: "Firefox",
	description: "Unencrypted .csv export",
	imageDescription: "Firefox logo",
	accentColor: "#FF7139",
	fileAccept: ".csv",
	fileTypeLabel: ".csv",

	canParse(file: File): boolean {
		return file.name.toLowerCase().endsWith(".csv");
	},

	async parse(file: File): Promise<ImportPreview> {
		if (!firefoxImportProvider.canParse(file)) {
			throw new ImportProviderError("unsupported-file-type", {
				format: firefoxImportProvider.fileTypeLabel,
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
		if (sourceItem.providerId !== firefoxImportProvider.id) {
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
	// The whole file is parsed and structurally validated up front. Anything
	// structurally wrong throws here, before a single item is built.
	const table = parseCsv(text, { requiredHeaders: CSV_REQUIRED_HEADERS });
	const columns = buildColumnIndex(table.headers);

	if (table.rows.length === 0) {
		throw new ImportProviderError("no-items-found");
	}

	const warnings: ImportWarning[] = [];
	const sourceItems: ImportSourceItem[] = [];
	let skippedCount = 0;

	table.rows.forEach((row, index) => {
		// Row 1 is the header, so the first data row is row 2.
		const rowNumber = index + 2;
		const itemId = `firefox-row-${rowNumber}`;

		const rawUrl = readCsvColumn(row, columns, "url").trim();
		const username = readCsvColumn(row, columns, "username").trim();
		const password = readCsvColumn(row, columns, "password");

		// Resolved before any per-item warning, so a row that never reaches the
		// vault does not also report a derived title.
		if (rawUrl.toLowerCase() === SYNC_ACCOUNT_ORIGIN) {
			skippedCount += 1;
			warnings.push({
				code: "sync-account-skipped",
				sourceVaultId: SOURCE_VAULT_ID,
				sourceItemId: itemId,
			});
			return;
		}

		// Nothing to import and nothing to name the item after.
		if (!rawUrl && !username && !password) {
			skippedCount += 1;
			warnings.push({
				code: "invalid-item",
				params: { itemNumber: index + 1, vaultName: SOURCE_VAULT_NAME },
				sourceVaultId: SOURCE_VAULT_ID,
				sourceItemId: itemId,
			});
			return;
		}

		// Firefox exports no title column, so one is derived from the URL.
		const derivedTitle = deriveTitleFromUrl(rawUrl);
		const title = derivedTitle || `Imported item ${index + 1}`;
		if (!derivedTitle) {
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

		const url = normalizeUrl(rawUrl);

		// `httpRealm` is the authentication realm of an HTTP-auth login. It is
		// the one piece of exporter metadata Bittery has a use for, and it is
		// rare enough that a custom field is not noise. `formActionOrigin`,
		// `guid` and the three timestamps are deliberately dropped — see the
		// fixture README for why.
		const httpRealm = readCsvColumn(row, columns, "httpRealm").trim();
		const customFields: CustomField[] = httpRealm
			? [
					{
						id: buildCustomFieldId(itemId, 0),
						label: HTTP_REALM_FIELD_LABEL,
						value: httpRealm,
						type: "text",
					},
				]
			: [];

		const data: DecryptedItemData = {
			title,
			...(url ? { url, urls: [url] } : {}),
			...(username ? { username } : {}),
			...(password ? { password } : {}),
			...(customFields.length > 0 ? { customFields } : {}),
		};

		sourceItems.push({
			providerId: firefoxImportProvider.id,
			id: itemId,
			sourceVaultId: SOURCE_VAULT_ID,
			title,
			category: "login",
			// Firefox has no concept of a favourite login.
			favorite: false,
			data,
		});
	});

	const sourceVault: ImportSourceVault = {
		id: SOURCE_VAULT_ID,
		name: SOURCE_VAULT_NAME,
		itemCount: sourceItems.length,
		skippedCount,
	};

	return {
		providerId: firefoxImportProvider.id,
		sourceVaults: [sourceVault],
		sourceItems,
		warnings,
		errors: [],
		summary: {
			vaultCount: 1,
			itemCount: sourceItems.length,
			skippedCount,
			warningCount: warnings.length,
			errorCount: 0,
		},
	};
}

/**
 * Best-effort item name for a format that exports no titles.
 *
 * Prefers the host without a leading `www.`, which is what a user recognizes.
 * Origins with no host — `file://`, `chrome://…`, anything unparseable — fall
 * back to the raw value rather than to nothing, so the item is still findable.
 */
function deriveTitleFromUrl(rawUrl: string): string {
	if (!rawUrl) {
		return "";
	}

	try {
		const host = new URL(rawUrl).host;
		if (host) {
			return host.replace(/^www\./i, "");
		}
	} catch {
		// Not URL-shaped; fall through to the raw value.
	}

	return rawUrl;
}
