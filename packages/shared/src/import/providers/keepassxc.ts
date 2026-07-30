import type { DecryptedItemData } from "../../types";
import { buildColumnIndex, parseCsv, readCsvColumn } from "../csv";
import { normalizeUrl, parseTotpValue } from "../normalize";
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
 * Column layouts KeePassXC's own exporter writes, each pinned to a fixture in
 * `__tests__/fixtures/keepassxc`.
 *
 * `CsvExporter::exportHeader` (`src/format/CsvExporter.cpp`) hard-codes the
 * order, so matching is exact and ordered: a header that is merely similar is a
 * file shape we have never seen and must not guess at. Both the GUI's
 * *Database → Export → Export to CSV…* and `keepassxc-cli export --format csv`
 * go through this one exporter.
 *
 * Widen this list only together with a new pinned fixture.
 */
const HEADER_VARIANTS: readonly (readonly string[])[] = [
	// KeePassXC >= 2.6.3, which added TOTP, Icon and the two timestamps.
	[
		"group",
		"title",
		"username",
		"password",
		"url",
		"notes",
		"totp",
		"icon",
		"last modified",
		"created",
	],
	// KeePassXC 2.0 - 2.6.2.
	["group", "title", "username", "password", "url", "notes"],
];

/**
 * KeePass 1.x's documented CSV header. It overlaps with nothing above, so it
 * would be rejected anyway — it is detected by name only so the user is told
 * they exported from the wrong product instead of reading a column diff.
 */
const KEEPASS1_HEADERS = [
	"account",
	"login name",
	"password",
	"web site",
	"comments",
];

/** Fallback name for root-level entries; the app layer replaces it via `nameCode`. */
const NO_GROUP_VAULT_ID = "keepassxc-no-group";
const NO_GROUP_VAULT_NAME = "No Group";

/**
 * Collects source vaults in first-seen order and hands out deterministic ids.
 *
 * Group ids are numbered by first appearance rather than by the row a group
 * showed up on, so moving an entry between groups cannot renumber the vaults
 * after it. The unfoldered bucket takes a fixed id and does not consume a number.
 */
class SourceVaultBuilder {
	private readonly byName = new Map<string, ImportSourceVault>();
	private readonly byId = new Map<string, ImportSourceVault>();
	private readonly ordered: ImportSourceVault[] = [];
	private groupCount = 0;

	ensureGroup(name: string): string {
		const existing = this.byName.get(name);
		if (existing) {
			return existing.id;
		}
		this.groupCount += 1;
		const vault = this.add({
			id: `keepassxc-group-${this.groupCount}`,
			name,
			itemCount: 0,
			skippedCount: 0,
		});
		// Only real groups are keyed by name: a group a user happened to call
		// "No Group" must not absorb the synthetic bucket below, or root-level
		// entries would be filed under it.
		this.byName.set(name, vault);
		return vault.id;
	}

	ensureNoGroup(): string {
		const existing = this.byId.get(NO_GROUP_VAULT_ID);
		if (existing) {
			return existing.id;
		}
		return this.add({
			id: NO_GROUP_VAULT_ID,
			name: NO_GROUP_VAULT_NAME,
			nameCode: "no-group",
			itemCount: 0,
			skippedCount: 0,
		}).id;
	}

	countItem(id: string): void {
		const vault = this.byId.get(id);
		if (vault) {
			vault.itemCount += 1;
		}
	}

	countSkipped(id: string): void {
		const vault = this.byId.get(id);
		if (vault) {
			vault.skippedCount += 1;
		}
	}

	toArray(): ImportSourceVault[] {
		return this.ordered;
	}

	private add(vault: ImportSourceVault): ImportSourceVault {
		this.byId.set(vault.id, vault);
		this.ordered.push(vault);
		return vault;
	}
}

export const keepassxcImportProvider: ImportProvider = {
	id: "keepassxc",
	title: "KeePassXC",
	description: "Unencrypted .csv export",
	imageDescription: "KeePassXC logo",
	accentColor: "#6CAC4D",
	fileAccept: ".csv",
	fileTypeLabel: ".csv",

	canParse(file: File): boolean {
		return file.name.toLowerCase().endsWith(".csv");
	},

	async parse(file: File): Promise<ImportPreview> {
		if (!keepassxcImportProvider.canParse(file)) {
			throw new ImportProviderError("unsupported-file-type", {
				format: keepassxcImportProvider.fileTypeLabel,
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
		if (sourceItem.providerId !== keepassxcImportProvider.id) {
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
	const vaults = new SourceVaultBuilder();
	const sourceItems: ImportSourceItem[] = [];
	let skippedCount = 0;

	table.rows.forEach((row, index) => {
		// Row 1 is the header, so the first data row is row 2.
		const rowNumber = index + 2;

		const groupName = readGroupName(readCsvColumn(row, columns, "group"));
		const sourceVaultId = groupName
			? vaults.ensureGroup(groupName)
			: vaults.ensureNoGroup();
		const vaultName = groupName || NO_GROUP_VAULT_NAME;
		const itemId = `${sourceVaultId}-row-${rowNumber}`;

		const rawTitle = readCsvColumn(row, columns, "title").trim();
		const username = readCsvColumn(row, columns, "username").trim();
		const password = readCsvColumn(row, columns, "password");
		const rawUrl = readCsvColumn(row, columns, "url").trim();
		const notes = readCsvColumn(row, columns, "notes");
		// Absent in the six-column layout, where this reads as empty.
		const rawTotp = readCsvColumn(row, columns, "totp").trim();

		// Resolved before any per-item warning, so a row that never reaches a
		// vault does not also report a derived title. KeePassXC lets an entry be
		// completely blank, and such a row carries nothing to import and nothing
		// to name an item after.
		if (!rawTitle && !username && !password && !rawUrl && !notes && !rawTotp) {
			skippedCount += 1;
			vaults.countSkipped(sourceVaultId);
			warnings.push({
				code: "invalid-item",
				params: { itemNumber: index + 1, vaultName },
				sourceVaultId,
				sourceItemId: itemId,
			});
			return;
		}

		const title = rawTitle || `Imported item ${index + 1}`;
		if (!rawTitle) {
			warnings.push({
				code: "missing-title",
				params: { itemNumber: index + 1, vaultName, title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const url = normalizeUrl(rawUrl);

		const totp = rawTotp ? parseTotpValue(rawTotp) : null;
		if (rawTotp && !totp) {
			warnings.push({
				code: "totp-secret-missing",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}
		if (totp && hasUnsupportedTotpSettings(rawTotp)) {
			warnings.push({
				code: "totp-settings-unsupported",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const data: DecryptedItemData = {
			title,
			...(url ? { url, urls: [url] } : {}),
			...(username ? { username } : {}),
			...(password ? { password } : {}),
			...(notes ? { notes } : {}),
			...buildTotpFields(totp),
		};

		sourceItems.push({
			providerId: keepassxcImportProvider.id,
			id: itemId,
			sourceVaultId,
			title,
			// KeePassXC models every entry the same way; there is no type column.
			sourceCategory: "login",
			category: "login",
			// KeePassXC has no concept of a favourite entry.
			favorite: false,
			data,
		});
		vaults.countItem(sourceVaultId);
	});

	const sourceVaults = vaults.toArray();

	return {
		providerId: keepassxcImportProvider.id,
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

	if (
		KEEPASS1_HEADERS.length === actual.length &&
		KEEPASS1_HEADERS.every((header, index) => header === actual[index])
	) {
		throw new ImportProviderError("keepassxc-keepass1-export-unsupported");
	}

	throw new ImportProviderError("csv-unknown-header-variant", {
		headers: headers.join(","),
		expected: HEADER_VARIANTS.map((variant) => variant.join(",")).join(" | "),
	});
}

/**
 * Turn a KeePassXC group path into the source vault name the user maps.
 *
 * `CsvExporter::exportGroup` starts every path at the database's root group, so
 * the first segment is the same for every row and names the database rather than
 * a folder the user filed anything under — it is dropped. The rest of the path is
 * kept verbatim, `/` separators included, so `Root/Work/Servers` arrives as one
 * `Work/Servers` vault rather than being flattened into `Work` or exploded into a
 * hierarchy Bittery has no way to represent.
 *
 * An empty result means the entry sat directly in the root group; the caller
 * routes those into the synthetic "No Group" vault.
 */
function readGroupName(rawGroup: string): string {
	const segments = rawGroup.split("/");
	return segments.slice(1).join("/").trim();
}

/**
 * KeePassXC always exports TOTP as an `otpauth://` URI — `Entry::totpSettingsString`
 * passes `forceOtp`, so even entries stored in the legacy `[step];[digits]` or
 * KeeOtp attribute formats are converted on the way out — but it can describe
 * settings Bittery cannot reproduce. Bittery would then generate a valid-looking
 * code that does not match the one KeePassXC shows, so the loss is reported.
 *
 * Two cases exist today:
 *
 * - a non-empty `encoder` (Steam's alphabet is the only one KeePassXC ships), and
 * - a `digits` count outside 6-8, which `TotpDigits` cannot hold.
 */
function hasUnsupportedTotpSettings(rawTotp: string): boolean {
	let params: URLSearchParams;
	try {
		params = new URL(rawTotp).searchParams;
	} catch {
		// A bare base32 seed carries no settings to lose.
		return false;
	}

	if ((params.get("encoder") ?? "").trim()) {
		return true;
	}

	const digits = params.get("digits");
	if (digits !== null) {
		const parsed = Number.parseInt(digits, 10);
		if (parsed !== 6 && parsed !== 7 && parsed !== 8) {
			return true;
		}
	}

	return false;
}

function buildTotpFields(
	totp: ReturnType<typeof parseTotpValue>,
): Partial<DecryptedItemData> {
	if (!totp) {
		return {};
	}
	return {
		totpSecret: totp.secret,
		...(totp.issuer ? { totpIssuer: totp.issuer } : {}),
		...(totp.accountName ? { totpAccountName: totp.accountName } : {}),
		...(totp.algorithm ? { totpAlgorithm: totp.algorithm } : {}),
		...(totp.digits ? { totpDigits: totp.digits } : {}),
		...(totp.period ? { totpPeriod: totp.period } : {}),
	};
}
