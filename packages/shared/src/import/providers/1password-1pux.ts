import JSZip, { type JSZipObject } from "jszip";
import type { Address, PhoneNumber } from "../../identity";
import type {
	DecryptedItemData,
	ItemCategory,
	TotpAlgorithm,
	TotpDigits,
} from "../../types";
import type {
	ImportDecryptedItem,
	ImportPreview,
	ImportProvider,
	ImportSourceItem,
	ImportSourceVault,
	ImportWarning,
} from "../types";
import { ImportProviderError } from "../types";

const CATEGORY_UUID_MAP: Record<string, ItemCategory> = {
	"001": "login",
	"002": "credit-card",
	"003": "secure-note",
	"004": "identity",
	"005": "login",
	"111": "totp",
};

interface ParsedField {
	index: number;
	key: string;
	label: string;
	designation: string;
	type: string;
	value: string;
}

interface CategoryResolution {
	category: ItemCategory;
	isFallback: boolean;
}

interface TotpInfo {
	secret?: string;
	issuer?: string;
	accountName?: string;
	algorithm?: TotpAlgorithm;
	digits?: TotpDigits;
	period?: number;
}

interface ParsedVault {
	vault: ImportSourceVault;
	items: ImportSourceItem[];
}

interface VaultCandidate {
	id: string;
	name: string;
	items: unknown[];
}

export const onePassword1puxImportProvider: ImportProvider = {
	id: "1password-1pux",
	title: "1Password",
	description: "Encrypted vault export",
	imageDescription: "1Password shield logo",
	accentColor: "#3B82F6",
	fileAccept: ".1pux",
	fileTypeLabel: ".1pux",

	canParse(file: File): boolean {
		const fileName = file.name.toLowerCase();
		return fileName.endsWith(".1pux");
	},

	async parse(file: File): Promise<ImportPreview> {
		const warnings: ImportWarning[] = [];
		const sourceVaults: ImportSourceVault[] = [];
		const sourceItems: ImportSourceItem[] = [];

		const payload = await parse1puxArchive(file);
		const vaultCandidates = extractVaultCandidates(payload);

		if (vaultCandidates.length === 0) {
			throw new ImportProviderError("no-vaults-found");
		}

		for (const vaultCandidate of vaultCandidates) {
			const parsed = parseVault(vaultCandidate, warnings);
			sourceVaults.push(parsed.vault);
			sourceItems.push(...parsed.items);
		}

		const skippedCount = sourceVaults.reduce(
			(total, vault) => total + vault.skippedCount,
			0,
		);

		return {
			providerId: onePassword1puxImportProvider.id,
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
		if (sourceItem.providerId !== onePassword1puxImportProvider.id) {
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

async function parse1puxArchive(file: File): Promise<unknown> {
	if (!onePassword1puxImportProvider.canParse(file)) {
		throw new ImportProviderError("unsupported-file-type");
	}

	let archiveEntries: JSZipObject[];
	try {
		const archiveBuffer = await file.arrayBuffer();
		const archive = await JSZip.loadAsync(archiveBuffer);
		archiveEntries = Object.values(archive.files);
	} catch {
		throw new ImportProviderError("archive-read-failed");
	}

	const exportDataEntry = findExportDataEntry(archiveEntries);
	if (!exportDataEntry) {
		throw new ImportProviderError("missing-export-data");
	}

	let exportDataText: string;
	try {
		exportDataText = await exportDataEntry.async("string");
	} catch {
		throw new ImportProviderError("read-export-data-failed");
	}

	try {
		return JSON.parse(exportDataText);
	} catch {
		throw new ImportProviderError("invalid-export-data-json");
	}
}

function findExportDataEntry(entries: JSZipObject[]): JSZipObject | null {
	const fileEntries = entries.filter((entry) => !entry.dir);
	const exactMatch = fileEntries.find(
		(entry) =>
			entry.name === "export.data" || entry.name.endsWith("/export.data"),
	);
	if (exactMatch) {
		return exactMatch;
	}

	const dataFallback = fileEntries.find((entry) =>
		entry.name.toLowerCase().endsWith(".data"),
	);
	if (dataFallback) {
		return dataFallback;
	}

	return (
		fileEntries.find((entry) => entry.name.toLowerCase().endsWith(".json")) ??
		null
	);
}

function parseVault(
	vaultCandidate: VaultCandidate,
	warnings: ImportWarning[],
): ParsedVault {
	const parsedItems: ImportSourceItem[] = [];
	let skippedCount = 0;

	vaultCandidate.items.forEach((rawItem, index) => {
		try {
			const parsedItem = parseItem(rawItem, vaultCandidate, index, warnings);
			if (!parsedItem) {
				skippedCount += 1;
				return;
			}
			parsedItems.push(parsedItem);
		} catch {
			warnings.push({
				code: "item-parse-failed",
				params: {
					itemNumber: index + 1,
					vaultName: vaultCandidate.name,
				},
				sourceVaultId: vaultCandidate.id,
			});
			skippedCount += 1;
		}
	});

	return {
		vault: {
			id: vaultCandidate.id,
			name: vaultCandidate.name,
			itemCount: parsedItems.length,
			skippedCount,
		},
		items: parsedItems,
	};
}

function parseItem(
	rawItem: unknown,
	vault: VaultCandidate,
	index: number,
	warnings: ImportWarning[],
): ImportSourceItem | null {
	const item = asRecord(rawItem);
	if (!item) {
		warnings.push({
			code: "invalid-item",
			params: {
				itemNumber: index + 1,
				vaultName: vault.name,
			},
			sourceVaultId: vault.id,
		});
		return null;
	}

	const itemId = readString(item.uuid) ?? `${vault.id}-item-${index + 1}`;
	const sourceCategory = extractSourceCategory(item);
	const fields = collectFields(item);
	const attachmentCount = getAttachmentCount(item);
	const { title, usedFallbackTitle } = extractTitle(item, index);
	const hasTotpField = fields.some((field) => isTotpField(field));
	const state = readString(item.state)?.toLowerCase();

	if (state === "archived") {
		warnings.push({
			code: "archived-skipped",
			params: { title },
			sourceVaultId: vault.id,
			sourceItemId: itemId,
		});
		return null;
	}

	if (usedFallbackTitle) {
		warnings.push({
			code: "missing-title",
			params: {
				itemNumber: index + 1,
				vaultName: vault.name,
				title,
			},
			sourceVaultId: vault.id,
			sourceItemId: itemId,
		});
	}

	if (isDocumentItem(item, sourceCategory, fields)) {
		warnings.push({
			code: "documents-skipped",
			params: { title },
			sourceVaultId: vault.id,
			sourceItemId: itemId,
		});
		return null;
	}

	if (attachmentCount > 0) {
		warnings.push({
			code: "attachments-skipped",
			params: { title },
			sourceVaultId: vault.id,
			sourceItemId: itemId,
		});
	}

	const categoryResolution = resolveCategory(sourceCategory, hasTotpField);
	if (categoryResolution.isFallback) {
		warnings.push({
			code: "category-fallback",
			params: {
				title,
				sourceCategory,
			},
			sourceVaultId: vault.id,
			sourceItemId: itemId,
		});
	}

	const usedFieldIndexes = new Set<number>();
	let category = categoryResolution.category;
	let data: DecryptedItemData;

	const totp = extractTotpInfo(item, fields, usedFieldIndexes);

	if (category === "login") {
		data = buildLoginData(item, fields, title, totp, usedFieldIndexes, itemId);
	} else if (category === "credit-card") {
		data = buildCreditCardData(
			item,
			fields,
			title,
			usedFieldIndexes,
			itemId,
			totp,
		);
	} else if (category === "identity") {
		data = buildIdentityData(
			item,
			fields,
			title,
			usedFieldIndexes,
			itemId,
			totp,
		);
	} else if (category === "totp") {
		if (!totp?.secret) {
			warnings.push({
				code: "totp-secret-missing",
				params: { title },
				sourceVaultId: vault.id,
				sourceItemId: itemId,
			});
			category = "secure-note";
			data = buildSecureNoteData(item, fields, title, usedFieldIndexes, itemId);
		} else {
			data = buildTotpData(item, fields, title, usedFieldIndexes, itemId, totp);
		}
	} else {
		data = buildSecureNoteData(item, fields, title, usedFieldIndexes, itemId);
	}

	return {
		providerId: onePassword1puxImportProvider.id,
		id: itemId,
		sourceVaultId: vault.id,
		title,
		sourceCategory,
		category,
		favorite: readFavorite(item),
		data,
	};
}

function buildLoginData(
	item: Record<string, unknown>,
	fields: ParsedField[],
	title: string,
	totp: TotpInfo | null,
	usedFieldIndexes: Set<number>,
	itemId: string,
): DecryptedItemData {
	const urls = extractUrls(item, fields, usedFieldIndexes);
	const username = consumeFieldValue(fields, usedFieldIndexes, isUsernameField);
	const password = consumePrimaryPassword(fields, usedFieldIndexes);
	const notes = extractNotes(item, fields, usedFieldIndexes);
	const customFields = buildCustomFields(fields, usedFieldIndexes, itemId);
	const [primaryUrl, ...additionalUrls] = urls;

	return {
		title,
		...(primaryUrl ? { url: primaryUrl } : {}),
		...(additionalUrls.length > 0 ? { urls: additionalUrls } : {}),
		...(username ? { username } : {}),
		...(password ? { password } : {}),
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
		...(totp?.secret ? { totpSecret: totp.secret } : {}),
		...(totp?.issuer ? { totpIssuer: totp.issuer } : {}),
		...(totp?.accountName ? { totpAccountName: totp.accountName } : {}),
		...(totp?.algorithm ? { totpAlgorithm: totp.algorithm } : {}),
		...(totp?.digits ? { totpDigits: totp.digits } : {}),
		...(totp?.period ? { totpPeriod: totp.period } : {}),
	};
}

function buildSecureNoteData(
	item: Record<string, unknown>,
	fields: ParsedField[],
	title: string,
	usedFieldIndexes: Set<number>,
	itemId: string,
): DecryptedItemData {
	const notes = extractNotes(item, fields, usedFieldIndexes);
	const customFields = buildCustomFields(fields, usedFieldIndexes, itemId);

	return {
		title,
		note: notes ?? "",
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
	};
}

function buildCreditCardData(
	item: Record<string, unknown>,
	fields: ParsedField[],
	title: string,
	usedFieldIndexes: Set<number>,
	itemId: string,
	totp: TotpInfo | null,
): DecryptedItemData {
	const notes = extractNotes(item, fields, usedFieldIndexes);
	const cardholderName = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isCardholderField,
	);
	const cardNumber = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isCardNumberField,
	);
	const cvv = consumeFieldValue(fields, usedFieldIndexes, isCvvField);
	const expiryRaw = consumeFieldValue(fields, usedFieldIndexes, isExpiryField);
	const expiryDate = normalizeExpiryDate(expiryRaw ?? "");
	const billingAddress = extractBillingAddress(fields, usedFieldIndexes);
	const customFields = buildCustomFields(fields, usedFieldIndexes, itemId);

	return {
		title,
		cardholderName: cardholderName ?? "",
		cardNumber: cardNumber ?? "",
		cvv: cvv ?? "",
		expiryDate: expiryDate ?? "",
		...(billingAddress ? { billingAddress } : {}),
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
		...(totp?.secret ? { totpSecret: totp.secret } : {}),
		...(totp?.issuer ? { totpIssuer: totp.issuer } : {}),
		...(totp?.accountName ? { totpAccountName: totp.accountName } : {}),
		...(totp?.algorithm ? { totpAlgorithm: totp.algorithm } : {}),
		...(totp?.digits ? { totpDigits: totp.digits } : {}),
		...(totp?.period ? { totpPeriod: totp.period } : {}),
	};
}

function buildIdentityData(
	item: Record<string, unknown>,
	fields: ParsedField[],
	title: string,
	usedFieldIndexes: Set<number>,
	itemId: string,
	totp: TotpInfo | null,
): DecryptedItemData {
	const notes = extractNotes(item, fields, usedFieldIndexes);
	const firstName = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isFirstNameField,
	);
	const middleName = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isMiddleNameField,
	);
	const lastName = consumeFieldValue(fields, usedFieldIndexes, isLastNameField);
	const email = consumeFieldValue(fields, usedFieldIndexes, isEmailField);
	const dateOfBirth = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isDateOfBirthField,
	);
	const ssn = consumeFieldValue(fields, usedFieldIndexes, isSsnField);
	const passportNumber = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isPassportField,
	);
	const driversLicense = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isDriversLicenseField,
	);
	const phoneNumbers = extractPhoneNumbers(fields, usedFieldIndexes, itemId);
	const addresses = extractAddresses(fields, usedFieldIndexes, itemId);
	const customFields = buildCustomFields(fields, usedFieldIndexes, itemId);

	return {
		title,
		...(firstName ? { firstName } : {}),
		...(middleName ? { middleName } : {}),
		...(lastName ? { lastName } : {}),
		...(email ? { email } : {}),
		...(dateOfBirth ? { dateOfBirth } : {}),
		...(ssn ? { ssn } : {}),
		...(passportNumber ? { passportNumber } : {}),
		...(driversLicense ? { driversLicense } : {}),
		...(phoneNumbers.length > 0 ? { phoneNumbers } : {}),
		...(addresses.length > 0 ? { addresses } : {}),
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
		...(totp?.secret ? { totpSecret: totp.secret } : {}),
		...(totp?.issuer ? { totpIssuer: totp.issuer } : {}),
		...(totp?.accountName ? { totpAccountName: totp.accountName } : {}),
		...(totp?.algorithm ? { totpAlgorithm: totp.algorithm } : {}),
		...(totp?.digits ? { totpDigits: totp.digits } : {}),
		...(totp?.period ? { totpPeriod: totp.period } : {}),
	};
}

function buildTotpData(
	item: Record<string, unknown>,
	fields: ParsedField[],
	title: string,
	usedFieldIndexes: Set<number>,
	itemId: string,
	totp: TotpInfo,
): DecryptedItemData {
	const notes = extractNotes(item, fields, usedFieldIndexes);
	const customFields = buildCustomFields(fields, usedFieldIndexes, itemId);

	return {
		title,
		totpSecret: totp.secret ?? "",
		...(totp.issuer ? { totpIssuer: totp.issuer } : {}),
		...(totp.accountName ? { totpAccountName: totp.accountName } : {}),
		...(totp.algorithm ? { totpAlgorithm: totp.algorithm } : {}),
		...(totp.digits ? { totpDigits: totp.digits } : {}),
		...(totp.period ? { totpPeriod: totp.period } : {}),
		...(notes ? { notes } : {}),
		...(customFields.length > 0 ? { customFields } : {}),
	};
}

function extractSourceCategory(item: Record<string, unknown>): string {
	const overview = asRecord(item.overview);
	return (
		readString(item.categoryUuid) ??
		readString(item.category) ??
		readString(item.templateUuid) ??
		readString(item.typeName) ??
		readString(item.type) ??
		readString(overview?.subtitle) ??
		""
	);
}

function extractTitle(
	item: Record<string, unknown>,
	index: number,
): { title: string; usedFallbackTitle: boolean } {
	const overview = asRecord(item.overview);
	const explicitTitle =
		readString(item.title) ??
		readString(item.name) ??
		readString(overview?.title) ??
		readString(overview?.ainfo);
	const fallbackTitle = `Imported item ${index + 1}`;
	if (!explicitTitle || !explicitTitle.trim()) {
		return {
			title: fallbackTitle,
			usedFallbackTitle: true,
		};
	}
	return {
		title: explicitTitle.trim(),
		usedFallbackTitle: false,
	};
}

function getAttachmentCount(item: Record<string, unknown>): number {
	const details = asRecord(item.details);
	let count = 0;
	count += toArray(details?.files).length;
	count += toArray(details?.attachments).length;
	count += toArray(item.files).length;
	count += toArray(item.attachments).length;
	if (asRecord(details?.file) || asRecord(item.file)) {
		count += 1;
	}
	if (
		asRecord(details?.documentAttributes) ||
		asRecord(item.documentAttributes)
	) {
		count += 1;
	}
	return count;
}

function isDocumentItem(
	item: Record<string, unknown>,
	sourceCategory: string,
	fields: ParsedField[],
): boolean {
	const normalized = normalizeKey(sourceCategory);
	if (
		normalized.includes("document") ||
		normalized.includes("file") ||
		normalized.includes("attachment")
	) {
		return true;
	}

	const details = asRecord(item.details);
	const hasFilePointer = !!(asRecord(item.file) || asRecord(details?.file));
	const overview = asRecord(item.overview);
	const hasOverviewUrl = !!readString(overview?.url);
	const hasUsableFields = fields.length > 0;

	if (hasFilePointer && !hasUsableFields && !hasOverviewUrl) {
		return true;
	}
	return false;
}

function resolveCategory(
	sourceCategory: string,
	hasTotpField: boolean,
): CategoryResolution {
	const normalized = normalizeKey(sourceCategory);

	if (normalized && CATEGORY_UUID_MAP[normalized]) {
		return {
			category: CATEGORY_UUID_MAP[normalized],
			isFallback: false,
		};
	}

	if (
		normalized.includes("totp") ||
		normalized.includes("otp") ||
		normalized.includes("onetimepassword")
	) {
		return { category: "totp", isFallback: false };
	}

	if (
		normalized.includes("credit") ||
		normalized.includes("card") ||
		normalized.includes("payment")
	) {
		return { category: "credit-card", isFallback: false };
	}

	if (
		normalized.includes("identity") ||
		normalized.includes("passport") ||
		normalized.includes("license") ||
		normalized.includes("person")
	) {
		return { category: "identity", isFallback: false };
	}

	if (normalized.includes("note")) {
		return { category: "secure-note", isFallback: false };
	}

	if (
		normalized.includes("login") ||
		normalized.includes("password") ||
		normalized.includes("website") ||
		normalized.includes("server")
	) {
		return { category: "login", isFallback: false };
	}

	if (hasTotpField) {
		return { category: "totp", isFallback: false };
	}

	return { category: "login", isFallback: true };
}

function extractUrls(
	item: Record<string, unknown>,
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
): string[] {
	const urls = new Set<string>();
	const overview = asRecord(item.overview);

	const addUrl = (value: string | null | undefined) => {
		if (!value) return;
		const normalized = normalizeUrl(value);
		if (normalized) {
			urls.add(normalized);
		}
	};

	addUrl(readString(overview?.url));

	for (const urlValue of toArray(overview?.urls)) {
		if (typeof urlValue === "string") {
			addUrl(urlValue);
			continue;
		}
		const urlObject = asRecord(urlValue);
		addUrl(readString(urlObject?.url) ?? readString(urlObject?.href));
	}

	const urlFields = consumeAllFields(fields, usedFieldIndexes, isUrlField);
	for (const field of urlFields) {
		addUrl(field.value);
	}

	return Array.from(urls);
}

function extractNotes(
	item: Record<string, unknown>,
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
): string | undefined {
	const details = asRecord(item.details);
	const notes =
		readString(details?.notesPlain) ??
		readString(details?.notes) ??
		readString(item.notesPlain) ??
		readString(item.notes);
	if (notes) {
		return notes;
	}

	return consumeFieldValue(fields, usedFieldIndexes, isNotesField);
}

function extractBillingAddress(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
): string | undefined {
	const directAddress = consumeFieldValue(
		fields,
		usedFieldIndexes,
		isBillingAddressField,
	);
	if (directAddress) {
		return directAddress;
	}

	const street = consumeFieldValue(fields, usedFieldIndexes, isStreetField);
	const city = consumeFieldValue(fields, usedFieldIndexes, isCityField);
	const state = consumeFieldValue(fields, usedFieldIndexes, isStateField);
	const zip = consumeFieldValue(fields, usedFieldIndexes, isZipField);
	const country = consumeFieldValue(fields, usedFieldIndexes, isCountryField);
	const addressParts = [street, city, state, zip, country].filter(Boolean);
	return addressParts.length > 0 ? addressParts.join(", ") : undefined;
}

function extractPhoneNumbers(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
	itemId: string,
): PhoneNumber[] {
	const phoneFields = consumeAllFields(fields, usedFieldIndexes, isPhoneField);
	return phoneFields.map((field, index) => ({
		id: `${itemId}-phone-${index + 1}`,
		label: field.label || `Phone ${index + 1}`,
		number: field.value,
	}));
}

function extractAddresses(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
	itemId: string,
): Address[] {
	const street =
		consumeFieldValue(fields, usedFieldIndexes, isStreetField) ??
		consumeFieldValue(fields, usedFieldIndexes, isAddressField);
	const city = consumeFieldValue(fields, usedFieldIndexes, isCityField);
	const state = consumeFieldValue(fields, usedFieldIndexes, isStateField);
	const zip = consumeFieldValue(fields, usedFieldIndexes, isZipField);
	const country = consumeFieldValue(fields, usedFieldIndexes, isCountryField);

	const hasAnyAddressPart = [street, city, state, zip, country].some(Boolean);
	if (!hasAnyAddressPart) {
		return [];
	}

	return [
		{
			id: `${itemId}-address-1`,
			street: street ?? "",
			city: city ?? "",
			state: state ?? "",
			zip: zip ?? "",
			country: country ?? "",
		},
	];
}

function extractTotpInfo(
	item: Record<string, unknown>,
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
): TotpInfo | null {
	const candidates: string[] = [];

	const candidateFields = fields.filter((field) => {
		return (
			isTotpField(field) || field.value.toLowerCase().startsWith("otpauth://")
		);
	});

	for (const field of candidateFields) {
		usedFieldIndexes.add(field.index);
		candidates.push(field.value);
	}

	const details = asRecord(item.details);
	const directCandidates = [
		readString(details?.totp),
		readString(details?.otp),
		readString(item.totp),
		readString(item.otp),
	];
	for (const candidate of directCandidates) {
		if (candidate) {
			candidates.push(candidate);
		}
	}

	for (const candidate of candidates) {
		const parsed = parseTotpCandidate(candidate);
		if (parsed?.secret) {
			return parsed;
		}
	}

	if (candidates.length > 0) {
		const firstCandidate = candidates[0];
		if (!firstCandidate) {
			return null;
		}
		const fallback = parseTotpCandidate(firstCandidate);
		if (fallback) {
			return fallback;
		}
	}

	return null;
}

function parseTotpCandidate(candidate: string): TotpInfo | null {
	const trimmed = candidate.trim();
	if (!trimmed) {
		return null;
	}

	if (!trimmed.toLowerCase().startsWith("otpauth://")) {
		return { secret: trimmed };
	}

	try {
		const url = new URL(trimmed);
		if (url.protocol !== "otpauth:") {
			return { secret: trimmed };
		}

		const rawPath = decodeURIComponent(url.pathname.replace(/^\//, ""));
		const [pathIssuer, pathAccountName] = rawPath.includes(":")
			? rawPath.split(/:(.+)/)
			: [undefined, rawPath];

		const secret = url.searchParams.get("secret")?.trim();
		const issuer = url.searchParams.get("issuer")?.trim() || pathIssuer;
		const accountName = pathAccountName?.trim();
		const algorithmRaw = url.searchParams.get("algorithm")?.toUpperCase();
		const digitsRaw = Number.parseInt(url.searchParams.get("digits") ?? "", 10);
		const periodRaw = Number.parseInt(url.searchParams.get("period") ?? "", 10);
		const algorithm: TotpAlgorithm | undefined =
			algorithmRaw === "SHA1" ||
			algorithmRaw === "SHA256" ||
			algorithmRaw === "SHA512"
				? algorithmRaw
				: undefined;
		const digits: TotpDigits | undefined =
			digitsRaw === 6 || digitsRaw === 7 || digitsRaw === 8
				? (digitsRaw as TotpDigits)
				: undefined;

		return {
			secret: secret ?? trimmed,
			...(issuer ? { issuer } : {}),
			...(accountName ? { accountName } : {}),
			...(algorithm ? { algorithm } : {}),
			...(digits ? { digits } : {}),
			...(Number.isFinite(periodRaw) && periodRaw > 0
				? { period: periodRaw }
				: {}),
		};
	} catch {
		return { secret: trimmed };
	}
}

function buildCustomFields(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
	itemId: string,
): Array<{
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}> {
	const customFields: Array<{
		id: string;
		label: string;
		value: string;
		type: "text" | "password" | "email" | "url";
	}> = [];

	for (const field of fields) {
		if (usedFieldIndexes.has(field.index)) {
			continue;
		}
		if (shouldIgnorePasswordField(field)) {
			usedFieldIndexes.add(field.index);
			continue;
		}

		customFields.push({
			id: `${itemId}-custom-${customFields.length + 1}`,
			label: field.label || "Custom Field",
			value: field.value,
			type: inferCustomFieldType(field),
		});
		usedFieldIndexes.add(field.index);
	}

	return customFields;
}

function consumePrimaryPassword(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
): string | undefined {
	const passwordCandidates = fields.filter(
		(field) => !usedFieldIndexes.has(field.index) && isPasswordField(field),
	);

	if (passwordCandidates.length === 0) {
		return undefined;
	}

	const hasMeaningfulPasswordCandidate = passwordCandidates.some(
		(field) => !isLikelyPasswordFlagValue(field.value),
	);
	const filteredCandidates = hasMeaningfulPasswordCandidate
		? passwordCandidates.filter(
				(field) => !isLikelyPasswordFlagValue(field.value),
			)
		: passwordCandidates;
	const nonConfirmationCandidates = filteredCandidates.filter(
		(field) => !isPasswordConfirmationField(field),
	);
	const selectionPool =
		nonConfirmationCandidates.length > 0
			? nonConfirmationCandidates
			: filteredCandidates;
	const selectedByDesignation = selectionPool.find(
		(field) => field.designation === "password",
	);
	const selected =
		selectedByDesignation ?? selectLongestFieldValue(selectionPool);

	if (!selected) {
		return undefined;
	}

	usedFieldIndexes.add(selected.index);

	for (const candidate of passwordCandidates) {
		if (candidate.index === selected.index) {
			continue;
		}
		if (
			shouldIgnorePasswordField(candidate) ||
			candidate.value === selected.value
		) {
			usedFieldIndexes.add(candidate.index);
		}
	}

	return selected.value;
}

function selectLongestFieldValue(
	fields: ParsedField[],
): ParsedField | undefined {
	return fields.reduce<ParsedField | undefined>((best, current) => {
		if (!best) {
			return current;
		}
		if (current.value.length > best.value.length) {
			return current;
		}
		return best;
	}, undefined);
}

function shouldIgnorePasswordField(field: ParsedField): boolean {
	return (
		isPasswordField(field) &&
		(isLikelyPasswordFlagValue(field.value) ||
			isPasswordConfirmationField(field))
	);
}

function isPasswordConfirmationField(field: ParsedField): boolean {
	return fieldMatches(field, [
		"repeat",
		"confirm",
		"confirmation",
		"again",
		"retype",
		"verify",
	]);
}

function isLikelyPasswordFlagValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (!normalized) {
		return true;
	}
	if (
		normalized === "0" ||
		normalized === "1" ||
		normalized === "true" ||
		normalized === "false" ||
		normalized === "yes" ||
		normalized === "no" ||
		normalized === "on" ||
		normalized === "off"
	) {
		return true;
	}
	return /^\d{1,2}$/.test(normalized);
}

function cleanFieldLabel(label: string): string {
	const trimmed = label.trim();
	if (!trimmed) {
		return "Field";
	}

	return (
		trimmed
			.replace(/^section_[a-z0-9]+:\s*/i, "")
			.replace(/^(?:saved on|gespeichert auf)\s+[^:]+:\s*/i, "")
			.trim() || "Field"
	);
}

function inferCustomFieldType(
	field: ParsedField,
): "text" | "password" | "email" | "url" {
	if (isPasswordField(field)) {
		return "password";
	}
	if (isEmailField(field)) {
		return "email";
	}
	if (isUrlField(field)) {
		return "url";
	}
	return "text";
}

function consumeFieldValue(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
	predicate: (field: ParsedField) => boolean,
): string | undefined {
	const field = consumeFirstField(fields, usedFieldIndexes, predicate);
	return field?.value;
}

function consumeFirstField(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
	predicate: (field: ParsedField) => boolean,
): ParsedField | null {
	for (const field of fields) {
		if (usedFieldIndexes.has(field.index)) {
			continue;
		}
		if (!predicate(field)) {
			continue;
		}
		usedFieldIndexes.add(field.index);
		return field;
	}
	return null;
}

function consumeAllFields(
	fields: ParsedField[],
	usedFieldIndexes: Set<number>,
	predicate: (field: ParsedField) => boolean,
): ParsedField[] {
	const matched: ParsedField[] = [];

	for (const field of fields) {
		if (usedFieldIndexes.has(field.index)) {
			continue;
		}
		if (!predicate(field)) {
			continue;
		}
		usedFieldIndexes.add(field.index);
		matched.push(field);
	}

	return matched;
}

function collectFields(item: Record<string, unknown>): ParsedField[] {
	const parsedFields: ParsedField[] = [];
	let index = 0;

	const pushField = (rawField: unknown) => {
		const field = asRecord(rawField);
		if (!field) return;

		const rawValue = readFieldValue(field);
		if (!rawValue) return;

		const labelBase =
			readString(field.title) ??
			readString(field.name) ??
			readString(field.id) ??
			readString(field.designation) ??
			"Field";
		const label = cleanFieldLabel(labelBase);
		const key = normalizeKey(
			readString(field.id) ??
				readString(field.designation) ??
				readString(field.name) ??
				labelBase,
		);
		const designation = normalizeKey(readString(field.designation) ?? "");
		const type = normalizeKey(
			readString(field.type) ?? readString(field.fieldType) ?? "",
		);

		parsedFields.push({
			index: index++,
			key,
			label,
			designation,
			type,
			value: rawValue,
		});
	};

	for (const rawField of toArray(item.fields)) {
		pushField(rawField);
	}

	const details = asRecord(item.details);
	for (const rawField of toArray(details?.fields)) {
		pushField(rawField);
	}
	for (const rawField of toArray(details?.loginFields)) {
		pushField(rawField);
	}

	for (const rawSection of toArray(details?.sections)) {
		const section = asRecord(rawSection);
		for (const rawField of toArray(section?.fields)) {
			pushField(rawField);
		}
	}

	return parsedFields;
}

function readFieldValue(field: Record<string, unknown>): string | null {
	const candidates = [
		field.value,
		field.v,
		field.text,
		field.string,
		field.data,
		field.concealed,
	];

	for (const candidate of candidates) {
		const normalized = normalizeScalarValue(candidate);
		if (normalized) {
			return normalized;
		}
	}

	return null;
}

function normalizeScalarValue(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (asRecord(value)) {
		const record = asRecord(value);
		if (!record) {
			return null;
		}

		const preferredKeys = [
			"concealed",
			"value",
			"text",
			"string",
			"url",
			"email",
			"number",
			"phone",
			"address",
			"secret",
			"totp",
			"otp",
			"t",
		];

		for (const key of preferredKeys) {
			const normalized = normalizeScalarValue(record[key]);
			if (normalized) {
				return normalized;
			}
		}

		for (const nestedValue of Object.values(record)) {
			const normalized = normalizeScalarValue(nestedValue);
			if (normalized) {
				return normalized;
			}
		}
	}
	return null;
}

function extractVaultCandidates(payload: unknown): VaultCandidate[] {
	if (Array.isArray(payload)) {
		return [
			{
				id: "vault-1",
				name: "Imported Vault",
				items: payload,
			},
		];
	}

	const root = asRecord(payload);
	if (!root) {
		return [];
	}

	const accountVaults: VaultCandidate[] = [];
	const accounts = toArray(root.accounts);
	if (accounts.length > 0) {
		accounts.forEach((rawAccount, accountIndex) => {
			const account = asRecord(rawAccount);
			if (!account) return;
			const accountAttrs = asRecord(account.attrs);
			const accountName =
				readString(accountAttrs?.name) ??
				readString(accountAttrs?.accountName) ??
				readString(account.name) ??
				`Account ${accountIndex + 1}`;
			const vaults = toArray(account.vaults);
			vaults.forEach((rawVault, vaultIndex) => {
				const vault = asRecord(rawVault);
				if (!vault) return;
				const attrs = asRecord(vault.attrs);
				const id =
					readString(attrs?.uuid) ??
					readString(vault.uuid) ??
					`${accountIndex + 1}-${vaultIndex + 1}`;
				const name =
					readString(attrs?.name) ??
					readString(vault.name) ??
					`${accountName} Vault ${vaultIndex + 1}`;
				const items = toArray(vault.items);
				accountVaults.push({
					id,
					name,
					items,
				});
			});
		});
	}

	if (accountVaults.length > 0) {
		return accountVaults;
	}

	const directVaults = toArray(root.vaults);
	if (directVaults.length > 0) {
		const parsedVaults: VaultCandidate[] = [];
		directVaults.forEach((rawVault, vaultIndex) => {
			const vault = asRecord(rawVault);
			if (!vault) return;
			const attrs = asRecord(vault.attrs);
			parsedVaults.push({
				id:
					readString(attrs?.uuid) ??
					readString(vault.uuid) ??
					`vault-${vaultIndex + 1}`,
				name:
					readString(attrs?.name) ??
					readString(vault.name) ??
					`Imported Vault ${vaultIndex + 1}`,
				items: toArray(vault.items),
			});
		});
		return parsedVaults;
	}

	const directItems = toArray(root.items);
	if (directItems.length > 0) {
		return [
			{
				id: readString(root.vaultId) ?? "vault-1",
				name: readString(root.vaultName) ?? "Imported Vault",
				items: directItems,
			},
		];
	}

	return [];
}

function normalizeUrl(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		return trimmed;
	}
	if (trimmed.startsWith("//")) {
		return `https:${trimmed}`;
	}
	if (trimmed.startsWith("www.")) {
		return `https://${trimmed}`;
	}
	if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) {
		return `https://${trimmed}`;
	}

	return trimmed;
}

function normalizeExpiryDate(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	if (/^\d{2}\/\d{2,4}$/.test(trimmed)) {
		return trimmed;
	}
	if (/^\d{4}-\d{2}$/.test(trimmed)) {
		return `${trimmed.slice(5, 7)}/${trimmed.slice(0, 4)}`;
	}
	if (/^\d{6}$/.test(trimmed)) {
		return `${trimmed.slice(0, 2)}/${trimmed.slice(2)}`;
	}
	if (/^\d{4}$/.test(trimmed)) {
		return `${trimmed.slice(0, 2)}/${trimmed.slice(2)}`;
	}
	return trimmed;
}

function isUsernameField(field: ParsedField): boolean {
	return (
		field.designation === "username" ||
		fieldMatches(field, ["username", "user", "login", "email"])
	);
}

function isPasswordField(field: ParsedField): boolean {
	return (
		field.designation === "password" ||
		field.type === "p" ||
		fieldMatches(field, ["password", "passcode"])
	);
}

function isNotesField(field: ParsedField): boolean {
	return fieldMatches(field, ["notes", "note", "comment", "remarks"]);
}

function isUrlField(field: ParsedField): boolean {
	return (
		field.type === "u" ||
		fieldMatches(field, ["url", "website", "link", "homepage"])
	);
}

function isCardholderField(field: ParsedField): boolean {
	return fieldMatches(field, ["cardholder", "nameoncard", "cardname"]);
}

function isCardNumberField(field: ParsedField): boolean {
	return fieldMatches(field, ["cardnumber", "ccnum", "ccnumber"]);
}

function isCvvField(field: ParsedField): boolean {
	return fieldMatches(field, ["cvv", "cvc", "securitycode"]);
}

function isExpiryField(field: ParsedField): boolean {
	return fieldMatches(field, ["expiry", "expiration", "expdate", "validuntil"]);
}

function isBillingAddressField(field: ParsedField): boolean {
	return fieldMatches(field, ["billingaddress", "billaddress"]);
}

function isFirstNameField(field: ParsedField): boolean {
	return fieldMatches(field, ["firstname", "givenname"]);
}

function isMiddleNameField(field: ParsedField): boolean {
	return fieldMatches(field, ["middlename"]);
}

function isLastNameField(field: ParsedField): boolean {
	return fieldMatches(field, ["lastname", "surname", "familyname"]);
}

function isEmailField(field: ParsedField): boolean {
	return field.type === "e" || fieldMatches(field, ["email"]);
}

function isDateOfBirthField(field: ParsedField): boolean {
	return fieldMatches(field, ["dateofbirth", "birthdate", "dob"]);
}

function isSsnField(field: ParsedField): boolean {
	return fieldMatches(field, ["ssn", "socialsecurity"]);
}

function isPassportField(field: ParsedField): boolean {
	return fieldMatches(field, ["passport"]);
}

function isDriversLicenseField(field: ParsedField): boolean {
	return fieldMatches(field, ["driverslicense", "driverlicense", "license"]);
}

function isPhoneField(field: ParsedField): boolean {
	return (
		field.type === "tel" ||
		fieldMatches(field, ["phone", "mobile", "cell", "telephone", "tel"])
	);
}

function isAddressField(field: ParsedField): boolean {
	return fieldMatches(field, ["address", "addressline", "street"]);
}

function isStreetField(field: ParsedField): boolean {
	return fieldMatches(field, ["street", "addressline1", "address1"]);
}

function isCityField(field: ParsedField): boolean {
	return fieldMatches(field, ["city", "town"]);
}

function isStateField(field: ParsedField): boolean {
	return fieldMatches(field, ["state", "province", "region"]);
}

function isZipField(field: ParsedField): boolean {
	return fieldMatches(field, ["zip", "postal", "postcode"]);
}

function isCountryField(field: ParsedField): boolean {
	return fieldMatches(field, ["country"]);
}

function isTotpField(field: ParsedField): boolean {
	return fieldMatches(field, [
		"totp",
		"otp",
		"onetimepassword",
		"verificationcode",
		"authenticator",
	]);
}

function fieldMatches(field: ParsedField, normalizedTokens: string[]): boolean {
	const haystacks = [
		field.key,
		field.designation,
		normalizeKey(field.label),
		field.type,
	].filter(Boolean);

	return normalizedTokens.some((token) =>
		haystacks.some((haystack) => haystack.includes(token)),
	);
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
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		return value === 1;
	}
	if (typeof value !== "string") {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "yes" || normalized === "1";
}

function readNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function readFavorite(item: Record<string, unknown>): boolean {
	const favIndex = readNumber(item.favIndex);
	if (typeof favIndex === "number") {
		return favIndex > 0;
	}
	return readBoolean(item.favorite) || readBoolean(item.fav);
}

function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
