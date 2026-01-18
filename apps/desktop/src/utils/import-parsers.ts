import type { ItemCategory } from "@bittery/shared/types";
import Papa from "papaparse";

/**
 * Custom field structure matching the app's expected format
 */
export interface CustomField {
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}

/**
 * Represents a parsed item ready to be imported into Bittery
 */
export interface ParsedImportItem {
	category: ItemCategory;
	favorite?: boolean;
	overview: {
		title: string;
		url?: string;
		username?: string;
		cardBrand?: string;
		maskedCardNumber?: string;
	};
	sensitiveData: {
		password?: string;
		notes?: string;
		customFields?: CustomField[];
		// Credit card fields
		cardNumber?: string;
		cvv?: string;
		expiryMonth?: string;
		expiryYear?: string;
		// Identity fields
		firstName?: string;
		lastName?: string;
		company?: string;
		address?: string;
		city?: string;
		state?: string;
		zip?: string;
		country?: string;
		phone?: string;
		email?: string;
	};
}

/**
 * Result of parsing an import file
 */
export interface ImportParseResult {
	success: boolean;
	items: ParsedImportItem[];
	errors: string[];
	warnings: string[];
}

/**
 * Parse 1Password CSV export format
 * Common format: Title, URL, Username, Password, Notes, Type, etc.
 */
export function parse1PasswordCSV(csvContent: string): ImportParseResult {
	const result: ImportParseResult = {
		success: false,
		items: [],
		errors: [],
		warnings: [],
	};

	try {
		const parseResult = Papa.parse<Record<string, string>>(csvContent, {
			header: true,
			skipEmptyLines: true,
			transformHeader: (header) => header.trim().toLowerCase(),
		});

		if (parseResult.errors.length > 0) {
			result.errors.push(
				...parseResult.errors.map((e) => `CSV parse error: ${e.message}`),
			);
		}

		for (const [index, row] of parseResult.data.entries()) {
			try {
				const item = parse1PasswordRow(row, index);
				if (item) {
					result.items.push(item);
				}
			} catch (error) {
				result.warnings.push(
					`Row ${index + 1}: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			}
		}

		if (result.items.length === 0 && result.errors.length === 0) {
			result.errors.push(
				"No valid items found in CSV. Please check the file format.",
			);
		} else {
			result.success = true;
		}
	} catch (error) {
		result.errors.push(
			`Failed to parse CSV: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}

	return result;
}

/**
 * Parse a single row from 1Password CSV export
 */
function parse1PasswordRow(
	row: Record<string, string>,
	index: number,
): ParsedImportItem | null {
	// Skip archived items
	const archived = row.archived || row.trashed;
	if (
		archived &&
		(archived.toLowerCase() === "true" ||
			archived.toLowerCase() === "yes" ||
			archived === "1")
	) {
		return null;
	}

	// Check for required fields
	const title =
		row.title || row.name || row.item || row.label || `Imported Item ${index + 1}`;

	if (!title || title.trim() === "") {
		throw new Error("Missing title");
	}

	// Detect item type from 1Password
	const type = (row.type || row.category || "").toLowerCase();
	const category = mapCategoryFrom1Password(type);

	const overview: ParsedImportItem["overview"] = {
		title: title.trim(),
	};

	const sensitiveData: ParsedImportItem["sensitiveData"] = {};

	// Parse favorite field
	let favorite = false;
	if (row.favorite || row.isfavorite) {
		const favoriteValue = (row.favorite || row.isfavorite).toLowerCase();
		favorite =
			favoriteValue === "true" ||
			favoriteValue === "yes" ||
			favoriteValue === "1";
	}

	// Map common login fields
	if (row.url || row.website) {
		overview.url = (row.url || row.website).trim();
	}

	if (row.username || row.user) {
		overview.username = (row.username || row.user).trim();
	}

	if (row.password || row.pwd) {
		sensitiveData.password = (row.password || row.pwd).trim();
	}

	if (row.notes || row.note || row.comments) {
		sensitiveData.notes = (row.notes || row.note || row.comments).trim();
	}

	// Credit card specific fields
	if (category === "credit-card") {
		if (row["card number"] || row.cardnumber || row.number) {
			const cardNumber = (
				row["card number"] ||
				row.cardnumber ||
				row.number
			).trim();
			sensitiveData.cardNumber = cardNumber;
			// Create masked version for overview
			if (cardNumber.length >= 4) {
				overview.maskedCardNumber = `•••• ${cardNumber.slice(-4)}`;
			}
		}

		if (row.cvv || row.cvc || row["security code"]) {
			sensitiveData.cvv = (
				row.cvv ||
				row.cvc ||
				row["security code"]
			).trim();
		}

		if (row["card brand"] || row.brand || row.type) {
			overview.cardBrand = (row["card brand"] || row.brand || row.type).trim();
		}

		// Parse expiry date
		const expiry = row.expiry || row["expiration date"] || row["exp date"];
		if (expiry) {
			const expiryParts = expiry.split("/");
			if (expiryParts.length === 2) {
				sensitiveData.expiryMonth = expiryParts[0].trim();
				sensitiveData.expiryYear = expiryParts[1].trim();
			}
		}
	}

	// Identity specific fields
	if (category === "identity") {
		if (row["first name"] || row.firstname) {
			sensitiveData.firstName = (row["first name"] || row.firstname).trim();
		}
		if (row["last name"] || row.lastname) {
			sensitiveData.lastName = (row["last name"] || row.lastname).trim();
		}
		if (row.company || row.organization) {
			sensitiveData.company = (row.company || row.organization).trim();
		}
		if (row.address || row.street) {
			sensitiveData.address = (row.address || row.street).trim();
		}
		if (row.city) {
			sensitiveData.city = row.city.trim();
		}
		if (row.state || row.province) {
			sensitiveData.state = (row.state || row.province).trim();
		}
		if (row.zip || row.zipcode || row.postalcode || row["postal code"]) {
			sensitiveData.zip = (
				row.zip ||
				row.zipcode ||
				row.postalcode ||
				row["postal code"]
			).trim();
		}
		if (row.country) {
			sensitiveData.country = row.country.trim();
		}
		if (row.phone || row.telephone) {
			sensitiveData.phone = (row.phone || row.telephone).trim();
		}
		if (row.email) {
			sensitiveData.email = row.email.trim();
		}
	}

	// Collect custom fields (any remaining fields not mapped)
	const customFieldsArray: CustomField[] = [];
	const standardFields = new Set([
		"title",
		"name",
		"item",
		"label",
		"url",
		"website",
		"username",
		"user",
		"password",
		"pwd",
		"notes",
		"note",
		"comments",
		"type",
		"category",
		"card number",
		"cardnumber",
		"number",
		"cvv",
		"cvc",
		"security code",
		"card brand",
		"brand",
		"expiry",
		"expiration date",
		"exp date",
		"first name",
		"firstname",
		"last name",
		"lastname",
		"company",
		"organization",
		"address",
		"street",
		"city",
		"state",
		"province",
		"zip",
		"zipcode",
		"postalcode",
		"postal code",
		"country",
		"phone",
		"telephone",
		"email",
		// Fields we explicitly don't import as custom fields
		"archived",
		"trashed",
		"favorite",
		"isfavorite",
		"tags",
	]);

	for (const [key, value] of Object.entries(row)) {
		if (
			!standardFields.has(key.toLowerCase()) &&
			value &&
			value.trim() !== ""
		) {
			// Generate a unique ID for each custom field
			const id = `${key.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
			customFieldsArray.push({
				id,
				label: key,
				value: value.trim(),
				type: "text",
			});
		}
	}

	if (customFieldsArray.length > 0) {
		sensitiveData.customFields = customFieldsArray;
	}

	return {
		category,
		favorite,
		overview,
		sensitiveData,
	};
}

/**
 * Map 1Password item type to Bittery category
 */
function mapCategoryFrom1Password(
	type: string,
): ItemCategory {
	const lowerType = type.toLowerCase();

	if (
		lowerType.includes("login") ||
		lowerType.includes("password") ||
		lowerType.includes("website")
	) {
		return "login";
	}

	if (
		lowerType.includes("credit") ||
		lowerType.includes("card") ||
		lowerType.includes("payment")
	) {
		return "credit-card";
	}

	if (
		lowerType.includes("identity") ||
		lowerType.includes("personal") ||
		lowerType.includes("contact")
	) {
		return "identity";
	}

	if (lowerType.includes("note") || lowerType.includes("secure note")) {
		return "secure-note";
	}

	// Default to login if unknown
	return "login";
}

/**
 * Parse 1Password JSON export format
 */
export function parse1PasswordJSON(jsonContent: string): ImportParseResult {
	const result: ImportParseResult = {
		success: false,
		items: [],
		errors: [],
		warnings: [],
	};

	try {
		const data = JSON.parse(jsonContent);

		// 1Password JSON exports typically have an items array
		const items = Array.isArray(data) ? data : data.items || [];

		if (!Array.isArray(items)) {
			result.errors.push("Invalid JSON format: expected an array of items");
			return result;
		}

		for (const [index, item] of items.entries()) {
			try {
				const parsed = parse1PasswordJSONItem(item, index);
				if (parsed) {
					result.items.push(parsed);
				}
			} catch (error) {
				result.warnings.push(
					`Item ${index + 1}: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			}
		}

		if (result.items.length === 0 && result.errors.length === 0) {
			result.errors.push(
				"No valid items found in JSON. Please check the file format.",
			);
		} else {
			result.success = true;
		}
	} catch (error) {
		result.errors.push(
			`Failed to parse JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}

	return result;
}

/**
 * Parse a single item from 1Password JSON export
 */
function parse1PasswordJSONItem(
	item: any,
	index: number,
): ParsedImportItem | null {
	// Skip archived items
	if (item.trashed === true || item.archived === true) {
		return null;
	}

	const title =
		item.title || item.name || item.overview?.title || `Imported Item ${index + 1}`;

	if (!title || title.trim() === "") {
		throw new Error("Missing title");
	}

	const type = item.typeName || item.category || item.templateUuid || "";
	const category = mapCategoryFrom1Password(type);

	const overview: ParsedImportItem["overview"] = {
		title: title.trim(),
	};

	const sensitiveData: ParsedImportItem["sensitiveData"] = {};

	// Parse favorite field
	const favorite = item.fav === true || item.favorite === true;

	// Extract fields from 1Password JSON structure
	const fields = item.fields || item.details?.fields || [];

	// Common fields
	if (item.overview?.url || item.url) {
		overview.url = (item.overview?.url || item.url).trim();
	}

	// Parse fields array
	for (const field of fields) {
		const name = (field.name || field.designation || "").toLowerCase();
		const value = field.value || "";

		if (!value || value.trim() === "") continue;

		switch (name) {
			case "username":
			case "email":
				overview.username = value.trim();
				break;
			case "password":
				sensitiveData.password = value.trim();
				break;
			case "notes":
			case "notesplain":
				sensitiveData.notes = value.trim();
				break;
			case "ccnum":
			case "cardnumber":
			case "card number":
				sensitiveData.cardNumber = value.trim();
				if (value.length >= 4) {
					overview.maskedCardNumber = `•••• ${value.slice(-4)}`;
				}
				break;
			case "cvv":
			case "cvc":
				sensitiveData.cvv = value.trim();
				break;
			case "type":
			case "card brand":
				if (category === "credit-card") {
					overview.cardBrand = value.trim();
				}
				break;
			case "expiry":
			case "exp_date": {
				const parts = value.split("/");
				if (parts.length === 2) {
					sensitiveData.expiryMonth = parts[0].trim();
					sensitiveData.expiryYear = parts[1].trim();
				}
				break;
			}
		}
	}

	// Handle notes from multiple locations
	if (item.notes || item.secureContents?.notesPlain) {
		sensitiveData.notes =
			(item.notes || item.secureContents?.notesPlain).trim();
	}

	return {
		category,
		favorite,
		overview,
		sensitiveData,
	};
}

/**
 * Detect and parse import file based on content
 */
export function parseImportFile(
	content: string,
	format: "csv" | "json",
): ImportParseResult {
	if (format === "csv") {
		return parse1PasswordCSV(content);
	}
	return parse1PasswordJSON(content);
}
