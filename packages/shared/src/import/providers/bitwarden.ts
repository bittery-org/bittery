import type { Address, PhoneNumber } from "../../identity";
import type {
	CustomField,
	DecryptedItemData,
	ItemCategory,
	PasswordHistoryEntry,
} from "../../types";
import { buildColumnIndex, parseCsv, readCsvColumn } from "../csv";
import {
	buildCustomFieldId,
	normalizeExpiryDate,
	normalizeUrl,
	parseTotpValue,
} from "../normalize";
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
 * Exact column set of a Bitwarden individual-vault CSV export.
 * An organization export starts with `collections` instead of `folder`.
 */
const CSV_REQUIRED_HEADERS = [
	"folder",
	"favorite",
	"type",
	"name",
	"notes",
	"fields",
	"reprompt",
	"login_uri",
	"login_username",
	"login_password",
	"login_totp",
];

const NO_FOLDER_VAULT_ID = "bitwarden-no-folder";

/** Fallback name; the app layer replaces it via `nameCode`. */
const NO_FOLDER_VAULT_NAME = "No Folder";

/** Bitwarden JSON item type discriminator. */
const JSON_ITEM_TYPE_LOGIN = 1;
const JSON_ITEM_TYPE_SECURE_NOTE = 2;
const JSON_ITEM_TYPE_CARD = 3;
const JSON_ITEM_TYPE_IDENTITY = 4;
const JSON_ITEM_TYPE_SSH_KEY = 5;

/** Bitwarden JSON custom-field type discriminator. Type 0 is plain text, the
 * default every non-boolean, non-linked field falls back to. */
const JSON_FIELD_TYPE_HIDDEN = 1;
const JSON_FIELD_TYPE_BOOLEAN = 2;
const JSON_FIELD_TYPE_LINKED = 3;

interface VaultAccumulator {
	vault: ImportSourceVault;
}

/**
 * Collects source vaults in first-seen order and hands out deterministic ids.
 */
class SourceVaultBuilder {
	private readonly byKey = new Map<string, VaultAccumulator>();
	private readonly byId = new Map<string, VaultAccumulator>();
	private readonly ordered: VaultAccumulator[] = [];

	ensure(
		key: string,
		id: string,
		name: string,
		nameCode?: "no-folder",
	): string {
		const existing = this.byKey.get(key);
		if (existing) {
			return existing.vault.id;
		}
		const accumulator: VaultAccumulator = {
			vault: {
				id,
				name,
				...(nameCode ? { nameCode } : {}),
				itemCount: 0,
				skippedCount: 0,
			},
		};
		this.byKey.set(key, accumulator);
		this.byId.set(id, accumulator);
		this.ordered.push(accumulator);
		return id;
	}

	/** Id of an already-registered vault, or undefined when the key is unknown. */
	idForKey(key: string): string | undefined {
		return this.byKey.get(key)?.vault.id;
	}

	countItem(id: string): void {
		const accumulator = this.byId.get(id);
		if (accumulator) {
			accumulator.vault.itemCount += 1;
		}
	}

	countSkipped(id: string): void {
		const accumulator = this.byId.get(id);
		if (accumulator) {
			accumulator.vault.skippedCount += 1;
		}
	}

	nameOf(id: string): string {
		return this.byId.get(id)?.vault.name ?? NO_FOLDER_VAULT_NAME;
	}

	toArray(): ImportSourceVault[] {
		return this.ordered.map((entry) => entry.vault);
	}
}

export const bitwardenImportProvider: ImportProvider = {
	id: "bitwarden",
	title: "Bitwarden",
	description: "Unencrypted .csv or .json export",
	imageDescription: "Bitwarden logo",
	accentColor: "#175DDC",
	fileAccept: ".csv,.json",
	fileTypeLabel: ".csv or .json",

	canParse(file: File): boolean {
		const fileName = file.name.toLowerCase();
		// `.zip` is accepted here on purpose so an attachment export reaches
		// `parse()` and gets its own actionable error instead of the generic
		// "file is not compatible with Bitwarden" the hook raises otherwise.
		return (
			fileName.endsWith(".csv") ||
			fileName.endsWith(".json") ||
			fileName.endsWith(".zip")
		);
	},

	async parse(file: File): Promise<ImportPreview> {
		if (!bitwardenImportProvider.canParse(file)) {
			throw new ImportProviderError("unsupported-file-type", {
				format: bitwardenImportProvider.fileTypeLabel,
			});
		}

		const fileName = file.name.toLowerCase();
		if (fileName.endsWith(".zip")) {
			throw new ImportProviderError("bitwarden-attachment-export-unsupported");
		}

		let text: string;
		try {
			text = await file.text();
		} catch {
			throw new ImportProviderError("read-export-data-failed");
		}

		// A ZIP renamed to `.json`/`.csv` is still an attachment export.
		if (text.startsWith("PK")) {
			throw new ImportProviderError("bitwarden-attachment-export-unsupported");
		}

		return fileName.endsWith(".csv")
			? parseCsvExport(text)
			: parseJsonExport(text);
	},

	toDecryptedItemData(sourceItem: ImportSourceItem): ImportDecryptedItem {
		if (sourceItem.providerId !== bitwardenImportProvider.id) {
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

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function parseCsvExport(text: string): ImportPreview {
	assertNotOrganizationCsv(text);

	// The whole file is parsed and structurally validated up front. Anything
	// structurally wrong throws here, before a single item is built.
	const table = parseCsv(text, { requiredHeaders: CSV_REQUIRED_HEADERS });
	const columns = buildColumnIndex(table.headers);

	if (table.rows.length === 0) {
		throw new ImportProviderError("no-items-found");
	}

	const warnings: ImportWarning[] = [];
	const vaults = new SourceVaultBuilder();
	const sourceItems: ImportSourceItem[] = [];
	let skippedCount = 0;

	table.rows.forEach((row, index) => {
		// Row 1 is the header, so the first data row is row 2.
		const rowNumber = index + 2;
		const folderName = readCsvColumn(row, columns, "folder").trim();
		const sourceVaultId = folderName
			? vaults.ensure(
					`folder:${folderName}`,
					buildFolderVaultId(index),
					folderName,
				)
			: vaults.ensure(
					"no-folder",
					NO_FOLDER_VAULT_ID,
					NO_FOLDER_VAULT_NAME,
					"no-folder",
				);
		const vaultName = folderName || NO_FOLDER_VAULT_NAME;
		const itemId = `${sourceVaultId}-row-${rowNumber}`;

		const rawTitle = readCsvColumn(row, columns, "name").trim();
		const title = rawTitle || `Imported item ${index + 1}`;

		// Skipped rows are resolved before any per-item warning, so a row that
		// never reaches the vault does not also report a renamed title.
		// `archivedDate` is not in Bitwarden's published header but real exports
		// carry it. Absent in older exports, hence read rather than required.
		if (readCsvColumn(row, columns, "archivedDate").trim()) {
			skippedCount += 1;
			vaults.countSkipped(sourceVaultId);
			warnings.push({
				code: "archived-skipped",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
			return;
		}

		if (!rawTitle) {
			warnings.push({
				code: "missing-title",
				params: { itemNumber: index + 1, vaultName, title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const sourceCategory = readCsvColumn(row, columns, "type").trim();
		const category = resolveCsvCategory(sourceCategory);
		if (!category) {
			warnings.push({
				code: "category-fallback",
				params: { title, sourceCategory },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}
		const resolvedCategory: ItemCategory = category ?? "login";

		if (readCsvColumn(row, columns, "reprompt").trim() === "1") {
			warnings.push({
				code: "reprompt-not-supported",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const notes = readCsvColumn(row, columns, "notes");
		const customFields = parseCsvCustomFields(
			readCsvColumn(row, columns, "fields"),
			itemId,
		);

		const urls = readCsvColumn(row, columns, "login_uri")
			.split(",")
			.map((candidate) => normalizeUrl(candidate))
			.filter((candidate): candidate is string => Boolean(candidate));

		const username = readCsvColumn(row, columns, "login_username").trim();
		const password = readCsvColumn(row, columns, "login_password");

		const rawTotp = readCsvColumn(row, columns, "login_totp").trim();
		const totp = rawTotp ? parseTotpValue(rawTotp) : null;
		if (rawTotp && !totp) {
			warnings.push({
				code: "totp-secret-missing",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const data: DecryptedItemData =
			resolvedCategory === "secure-note"
				? {
						title,
						// `note` is required for secure notes; `notes` mirrors it so
						// the generic notes surface stays populated too.
						note: notes,
						...(notes ? { notes } : {}),
						...(customFields.length > 0 ? { customFields } : {}),
					}
				: {
						title,
						...(urls[0] ? { url: urls[0] } : {}),
						...(urls.length > 0 ? { urls } : {}),
						...(username ? { username } : {}),
						...(password ? { password } : {}),
						...(notes ? { notes } : {}),
						...(customFields.length > 0 ? { customFields } : {}),
						...buildTotpFields(totp),
					};

		sourceItems.push({
			providerId: bitwardenImportProvider.id,
			id: itemId,
			sourceVaultId,
			title,
			...(sourceCategory ? { sourceCategory } : {}),
			category: resolvedCategory,
			favorite: readCsvColumn(row, columns, "favorite").trim() === "1",
			data,
		});
		vaults.countItem(sourceVaultId);
	});

	return buildPreview(vaults.toArray(), sourceItems, warnings, skippedCount);
}

/**
 * Bitwarden's organization export leads with `collections`. Detected before the
 * required-header check so the user is told to use an individual export instead
 * of being told the `folder` column is missing.
 */
function assertNotOrganizationCsv(text: string): void {
	const firstLine = text.replace(/^﻿/, "").split(/\r\n|\r|\n/, 1)[0] ?? "";
	if (firstLine.trim().toLowerCase().startsWith("collections")) {
		throw new ImportProviderError("bitwarden-organization-export-unsupported");
	}
}

function buildFolderVaultId(rowIndex: number): string {
	return `bitwarden-folder-${rowIndex + 1}`;
}

function resolveCsvCategory(sourceCategory: string): ItemCategory | null {
	switch (sourceCategory.toLowerCase()) {
		case "login":
			return "login";
		case "note":
			return "secure-note";
		default:
			return null;
	}
}

/**
 * The CSV `fields` column packs custom fields as newline-separated
 * `name: value` pairs. CSV cannot express hidden fields, so everything imports
 * as text.
 */
function parseCsvCustomFields(raw: string, itemId: string): CustomField[] {
	const fields: CustomField[] = [];
	for (const line of raw.split(/\r\n|\r|\n/)) {
		if (!line.trim()) {
			continue;
		}
		const separatorIndex = line.indexOf(":");
		const label =
			separatorIndex === -1
				? line.trim()
				: line.slice(0, separatorIndex).trim();
		const value =
			separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).trim();
		fields.push({
			id: buildCustomFieldId(itemId, fields.length),
			label: label || "Custom Field",
			value,
			type: "text",
		});
	}
	return fields;
}

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

function parseJsonExport(text: string): ImportPreview {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		throw new ImportProviderError("invalid-export-data-json");
	}

	const record = asRecord(root);
	if (!record) {
		throw new ImportProviderError("invalid-export-data-json");
	}

	assertNotEncryptedJson(record);

	if (toArray(record.collections).length > 0) {
		throw new ImportProviderError("bitwarden-organization-export-unsupported");
	}

	const items = toArray(record.items);
	if (items.length === 0) {
		throw new ImportProviderError("no-items-found");
	}

	const warnings: ImportWarning[] = [];
	const vaults = new SourceVaultBuilder();
	const sourceItems: ImportSourceItem[] = [];
	let skippedCount = 0;

	// Folders come first so empty folders still surface in the preview.
	for (const folder of toArray(record.folders)) {
		const folderRecord = asRecord(folder);
		const folderId = readString(folderRecord?.id);
		const folderName = readString(folderRecord?.name);
		if (!folderId || !folderName) {
			continue;
		}
		vaults.ensure(
			`folder:${folderId}`,
			`bitwarden-folder-${folderId}`,
			folderName,
		);
	}

	items.forEach((rawItem, index) => {
		const item = asRecord(rawItem);
		if (!item) {
			skippedCount += 1;
			warnings.push({
				code: "invalid-item",
				params: { itemNumber: index + 1, vaultName: NO_FOLDER_VAULT_NAME },
			});
			return;
		}

		// Folders are registered up front, so an unknown `folderId` is a dangling
		// reference. Falling back to the unfoldered bucket keeps the raw GUID from
		// surfacing as a vault name the user is asked to map.
		const folderId = readString(item.folderId);
		const folderVaultId = folderId
			? vaults.idForKey(`folder:${folderId}`)
			: undefined;
		const sourceVaultId =
			folderVaultId ??
			vaults.ensure(
				"no-folder",
				NO_FOLDER_VAULT_ID,
				NO_FOLDER_VAULT_NAME,
				"no-folder",
			);
		const itemId = readString(item.id) ?? `bitwarden-item-${index + 1}`;
		const vaultName = vaults.nameOf(sourceVaultId);

		const rawTitle = readString(item.name)?.trim();
		const title = rawTitle || `Imported item ${index + 1}`;

		// Skipped items are resolved before any per-item warning, so an item that
		// never reaches the vault does not also report a renamed title.
		// Trashed and archived are distinct states in Bitwarden and are reported
		// separately, but neither should land in a fresh vault as if it were live.
		if (readString(item.deletedDate)) {
			skippedCount += 1;
			vaults.countSkipped(sourceVaultId);
			warnings.push({
				code: "deleted-skipped",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
			return;
		}

		if (readString(item.archivedDate)) {
			skippedCount += 1;
			vaults.countSkipped(sourceVaultId);
			warnings.push({
				code: "archived-skipped",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
			return;
		}

		if (!rawTitle) {
			warnings.push({
				code: "missing-title",
				params: { itemNumber: index + 1, vaultName, title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const itemType = readNumber(item.type);
		const category = resolveJsonCategory(itemType);
		if (!category) {
			skippedCount += 1;
			vaults.countSkipped(sourceVaultId);
			warnings.push({
				code: "unsupported-item-type",
				params: { title, sourceCategory: describeJsonItemType(itemType) },
				sourceVaultId,
				sourceItemId: itemId,
			});
			return;
		}

		if (readNumber(item.reprompt) === 1) {
			warnings.push({
				code: "reprompt-not-supported",
				params: { title },
				sourceVaultId,
				sourceItemId: itemId,
			});
		}

		const notes = readString(item.notes) ?? "";
		const customFields = parseJsonCustomFields(
			toArray(item.fields),
			itemId,
			title,
			sourceVaultId,
			warnings,
		);

		let data: DecryptedItemData;
		switch (category) {
			case "login":
				data = buildJsonLoginData(
					item,
					title,
					notes,
					customFields,
					itemId,
					sourceVaultId,
					warnings,
				);
				break;
			case "secure-note":
				data = {
					title,
					note: notes,
					...(notes ? { notes } : {}),
					...(customFields.length > 0 ? { customFields } : {}),
				};
				break;
			case "credit-card":
				data = buildJsonCardData(item, title, notes, customFields);
				break;
			default:
				data = buildJsonIdentityData(item, title, notes, customFields, itemId);
				break;
		}

		sourceItems.push({
			providerId: bitwardenImportProvider.id,
			id: itemId,
			sourceVaultId,
			title,
			sourceCategory: describeJsonItemType(itemType),
			category,
			favorite: item.favorite === true,
			data,
		});
		vaults.countItem(sourceVaultId);
	});

	return buildPreview(vaults.toArray(), sourceItems, warnings, skippedCount);
}

/**
 * Reject password-protected and account-encrypted JSON exports explicitly.
 * Silently treating them as malformed plaintext would send the user hunting for
 * a corrupt file that is not corrupt.
 */
function assertNotEncryptedJson(record: Record<string, unknown>): void {
	if (
		record.encrypted === true ||
		record.passwordProtected === true ||
		"encKeyValidation_DO_NOT_EDIT" in record ||
		typeof record.data === "string"
	) {
		throw new ImportProviderError("bitwarden-encrypted-export-unsupported");
	}
}

function resolveJsonCategory(
	itemType: number | undefined,
): ItemCategory | null {
	switch (itemType) {
		case JSON_ITEM_TYPE_LOGIN:
			return "login";
		case JSON_ITEM_TYPE_SECURE_NOTE:
			return "secure-note";
		case JSON_ITEM_TYPE_CARD:
			return "credit-card";
		case JSON_ITEM_TYPE_IDENTITY:
			return "identity";
		default:
			// Type 5 is an SSH key; anything else is a format Bittery does not model.
			return null;
	}
}

function describeJsonItemType(itemType: number | undefined): string {
	switch (itemType) {
		case JSON_ITEM_TYPE_LOGIN:
			return "login";
		case JSON_ITEM_TYPE_SECURE_NOTE:
			return "note";
		case JSON_ITEM_TYPE_CARD:
			return "card";
		case JSON_ITEM_TYPE_IDENTITY:
			return "identity";
		case JSON_ITEM_TYPE_SSH_KEY:
			return "ssh-key";
		default:
			return `${itemType ?? "unknown"}`;
	}
}

function buildJsonLoginData(
	item: Record<string, unknown>,
	title: string,
	notes: string,
	customFields: CustomField[],
	itemId: string,
	sourceVaultId: string,
	warnings: ImportWarning[],
): DecryptedItemData {
	const login = asRecord(item.login);

	const urls = toArray(login?.uris)
		.map((entry) => readString(asRecord(entry)?.uri) ?? "")
		.map((candidate) => normalizeUrl(candidate))
		.filter((candidate): candidate is string => Boolean(candidate));

	const username = readString(login?.username)?.trim();
	const password = readString(login?.password);

	const rawTotp = readString(login?.totp)?.trim();
	const totp = rawTotp ? parseTotpValue(rawTotp) : null;
	if (rawTotp && !totp) {
		warnings.push({
			code: "totp-secret-missing",
			params: { title },
			sourceVaultId,
			sourceItemId: itemId,
		});
	}

	if (toArray(login?.fido2Credentials).length > 0) {
		warnings.push({
			code: "passkeys-skipped",
			params: { title },
			sourceVaultId,
			sourceItemId: itemId,
		});
	}

	const passwordHistory = parsePasswordHistory(toArray(item.passwordHistory));

	return {
		title,
		...(urls[0] ? { url: urls[0] } : {}),
		...(urls.length > 0 ? { urls } : {}),
		...(username ? { username } : {}),
		...(password ? { password } : {}),
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
		...(passwordHistory.length > 0 ? { passwordHistory } : {}),
		...buildTotpFields(totp),
	};
}

function buildJsonCardData(
	item: Record<string, unknown>,
	title: string,
	notes: string,
	customFields: CustomField[],
): DecryptedItemData {
	const card = asRecord(item.card);
	const cardholderName = readString(card?.cardholderName)?.trim();
	const cardNumber = readString(card?.number)?.trim();
	const cvv = readString(card?.code)?.trim();
	const expiryDate = normalizeExpiryDate(
		readString(card?.expMonth) ?? readNumber(card?.expMonth),
		readString(card?.expYear) ?? readNumber(card?.expYear),
	);

	return {
		title,
		...(cardholderName ? { cardholderName } : {}),
		...(cardNumber ? { cardNumber } : {}),
		...(cvv ? { cvv } : {}),
		...(expiryDate ? { expiryDate } : {}),
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
	};
}

function buildJsonIdentityData(
	item: Record<string, unknown>,
	title: string,
	notes: string,
	customFields: CustomField[],
	itemId: string,
): DecryptedItemData {
	const identity = asRecord(item.identity);

	const street = [
		readString(identity?.address1),
		readString(identity?.address2),
		readString(identity?.address3),
	]
		.map((line) => line?.trim())
		.filter((line): line is string => Boolean(line))
		.join("\n");

	const city = readString(identity?.city)?.trim() ?? "";
	const state = readString(identity?.state)?.trim() ?? "";
	const zip = readString(identity?.postalCode)?.trim() ?? "";
	const country = readString(identity?.country)?.trim() ?? "";

	const addresses: Address[] =
		street || city || state || zip || country
			? [{ id: `${itemId}-address-1`, street, city, state, zip, country }]
			: [];

	const phone = readString(identity?.phone)?.trim();
	const phoneNumbers: PhoneNumber[] = phone
		? [{ id: `${itemId}-phone-1`, label: "Phone", number: phone }]
		: [];

	// Bittery has no dedicated slots for these, so they become custom fields
	// rather than being dropped.
	const extraFields: CustomField[] = [...customFields];
	for (const [label, value] of [
		["Title", readString(identity?.title)],
		["Company", readString(identity?.company)],
		["Username", readString(identity?.username)],
	] as const) {
		const trimmed = value?.trim();
		if (!trimmed) {
			continue;
		}
		extraFields.push({
			id: buildCustomFieldId(itemId, extraFields.length),
			label,
			value: trimmed,
			type: "text",
		});
	}

	const firstName = readString(identity?.firstName)?.trim();
	const middleName = readString(identity?.middleName)?.trim();
	const lastName = readString(identity?.lastName)?.trim();
	const email = readString(identity?.email)?.trim();
	const ssn = readString(identity?.ssn)?.trim();
	const passportNumber = readString(identity?.passportNumber)?.trim();
	const driversLicense = readString(identity?.licenseNumber)?.trim();

	return {
		title,
		...(firstName ? { firstName } : {}),
		...(middleName ? { middleName } : {}),
		...(lastName ? { lastName } : {}),
		...(email ? { email } : {}),
		...(ssn ? { ssn } : {}),
		...(passportNumber ? { passportNumber } : {}),
		...(driversLicense ? { driversLicense } : {}),
		...(addresses.length > 0 ? { addresses } : {}),
		...(phoneNumbers.length > 0 ? { phoneNumbers } : {}),
		...(notes ? { notes } : {}),
		...(extraFields.length > 0 ? { customFields: extraFields } : {}),
	};
}

function parseJsonCustomFields(
	rawFields: unknown[],
	itemId: string,
	title: string,
	sourceVaultId: string,
	warnings: ImportWarning[],
): CustomField[] {
	const fields: CustomField[] = [];

	for (const rawField of rawFields) {
		const field = asRecord(rawField);
		if (!field) {
			continue;
		}

		const fieldType = readNumber(field.type);
		if (fieldType === JSON_FIELD_TYPE_LINKED) {
			// Linked fields reference another item's value; there is nothing to
			// carry across, so record the loss instead of importing an empty field.
			warnings.push({
				code: "linked-field-skipped",
				params: {
					title,
					fieldName: readString(field.name)?.trim() || "",
				},
				sourceVaultId,
				sourceItemId: itemId,
			});
			continue;
		}

		fields.push({
			id: buildCustomFieldId(itemId, fields.length),
			label: readString(field.name)?.trim() || "Custom Field",
			value: readCustomFieldValue(field, fieldType),
			type: fieldType === JSON_FIELD_TYPE_HIDDEN ? "password" : "text",
		});
	}

	return fields;
}

function readCustomFieldValue(
	field: Record<string, unknown>,
	fieldType: number | undefined,
): string {
	const raw = field.value;
	if (fieldType === JSON_FIELD_TYPE_BOOLEAN) {
		if (typeof raw === "boolean") {
			return raw ? "true" : "false";
		}
		return readString(raw) === "true" ? "true" : "false";
	}
	return readString(raw) ?? "";
}

function parsePasswordHistory(rawHistory: unknown[]): PasswordHistoryEntry[] {
	const entries: PasswordHistoryEntry[] = [];
	for (const rawEntry of rawHistory) {
		const entry = asRecord(rawEntry);
		const password = readString(entry?.password);
		if (!password) {
			continue;
		}
		entries.push({
			password,
			changedAt: readString(entry?.lastUsedDate) ?? "",
		});
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function buildPreview(
	sourceVaults: ImportSourceVault[],
	sourceItems: ImportSourceItem[],
	warnings: ImportWarning[],
	skippedCount: number,
): ImportPreview {
	return {
		providerId: bitwardenImportProvider.id,
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

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}
