/**
 * Credit card utilities for brand detection, validation, and masking
 */

export type CardBrand =
	| "visa"
	| "mastercard"
	| "amex"
	| "discover"
	| "diners"
	| "jcb"
	| "unionpay"
	| "unknown";

interface CardBrandConfig {
	name: CardBrand;
	pattern: RegExp;
	lengths: number[];
	cvvLength: number;
}

const CARD_BRANDS: CardBrandConfig[] = [
	{
		name: "visa",
		pattern: /^4/,
		lengths: [13, 16, 19],
		cvvLength: 3,
	},
	{
		name: "mastercard",
		pattern: /^(5[1-5]|2[2-7])/,
		lengths: [16],
		cvvLength: 3,
	},
	{
		name: "amex",
		pattern: /^3[47]/,
		lengths: [15],
		cvvLength: 4,
	},
	{
		name: "discover",
		pattern: /^(6011|65|64[4-9]|622)/,
		lengths: [16, 19],
		cvvLength: 3,
	},
	{
		name: "diners",
		pattern: /^(36|38|30[0-5])/,
		lengths: [14, 16],
		cvvLength: 3,
	},
	{
		name: "jcb",
		pattern: /^35/,
		lengths: [16, 19],
		cvvLength: 3,
	},
	{
		name: "unionpay",
		pattern: /^62/,
		lengths: [16, 17, 18, 19],
		cvvLength: 3,
	},
];

/**
 * Detect card brand from card number
 */
export function detectCardBrand(cardNumber: string): CardBrand {
	const cleaned = cardNumber.replace(/\s/g, "");

	for (const brand of CARD_BRANDS) {
		if (brand.pattern.test(cleaned)) {
			return brand.name;
		}
	}

	return "unknown";
}

/**
 * Get card brand configuration
 */
export function getCardBrandConfig(brand: CardBrand): CardBrandConfig | null {
	return CARD_BRANDS.find((b) => b.name === brand) || null;
}

/**
 * Validate card number using Luhn algorithm
 */
export function validateCardNumber(cardNumber: string): boolean {
	const cleaned = cardNumber.replace(/\s/g, "");

	// Check if it's all digits
	if (!/^\d+$/.test(cleaned)) {
		return false;
	}

	// Check length
	if (cleaned.length < 13 || cleaned.length > 19) {
		return false;
	}

	// Luhn algorithm
	let sum = 0;
	let isEven = false;

	for (let i = cleaned.length - 1; i >= 0; i--) {
		let digit = Number.parseInt(cleaned[i], 10);

		if (isEven) {
			digit *= 2;
			if (digit > 9) {
				digit -= 9;
			}
		}

		sum += digit;
		isEven = !isEven;
	}

	return sum % 10 === 0;
}

/**
 * Mask card number for display (shows last 4 digits)
 */
export function maskCardNumber(cardNumber: string): string {
	const cleaned = cardNumber.replace(/\s/g, "");
	if (cleaned.length < 4) {
		return "••••";
	}

	const last4 = cleaned.slice(-4);
	return `•••• ${last4}`;
}

/**
 * Format card number with spaces for better readability
 */
export function formatCardNumber(
	cardNumber: string,
	brand?: CardBrand,
): string {
	const cleaned = cardNumber.replace(/\s/g, "");

	// American Express: 4-6-5 format
	if (brand === "amex") {
		return cleaned.replace(/(\d{4})(\d{6})(\d{5})/, "$1 $2 $3").trim();
	}

	// Diners: 4-6-4 format
	if (brand === "diners" && cleaned.length === 14) {
		return cleaned.replace(/(\d{4})(\d{6})(\d{4})/, "$1 $2 $3").trim();
	}

	// Default: groups of 4
	return cleaned.replace(/(\d{4})/g, "$1 ").trim();
}

/**
 * Validate CVV based on card brand
 */
export function validateCVV(cvv: string, brand?: CardBrand): boolean {
	const cleaned = cvv.replace(/\s/g, "");

	if (!/^\d+$/.test(cleaned)) {
		return false;
	}

	if (brand) {
		const config = getCardBrandConfig(brand);
		if (config) {
			return cleaned.length === config.cvvLength;
		}
	}

	// Generic validation: 3 or 4 digits
	return cleaned.length === 3 || cleaned.length === 4;
}

/**
 * Parse expiry date (MM/YY or MM/YYYY format)
 */
export function parseExpiryDate(expiry: string): {
	month: number;
	year: number;
} | null {
	const cleaned = expiry.replace(/\s/g, "");
	const match = cleaned.match(/^(\d{1,2})\/?(\d{2,4})$/);

	if (!match) {
		return null;
	}

	const month = Number.parseInt(match[1], 10);
	let year = Number.parseInt(match[2], 10);

	// Convert 2-digit year to 4-digit
	if (year < 100) {
		year += 2000;
	}

	if (month < 1 || month > 12) {
		return null;
	}

	return { month, year };
}

/**
 * Validate expiry date (checks if card is not expired)
 */
export function validateExpiryDate(expiry: string): boolean {
	const parsed = parseExpiryDate(expiry);
	if (!parsed) {
		return false;
	}

	const now = new Date();
	const currentYear = now.getFullYear();
	const currentMonth = now.getMonth() + 1; // 0-indexed

	// Card expires at the end of the expiry month
	if (parsed.year < currentYear) {
		return false;
	}

	if (parsed.year === currentYear && parsed.month < currentMonth) {
		return false;
	}

	return true;
}

/**
 * Format expiry date as MM/YY
 */
export function formatExpiryDate(expiry: string): string {
	const parsed = parseExpiryDate(expiry);
	if (!parsed) {
		return expiry;
	}

	const month = parsed.month.toString().padStart(2, "0");
	const year = parsed.year.toString().slice(-2);

	return `${month}/${year}`;
}

/**
 * Get card brand display name
 */
export function getCardBrandDisplayName(brand: CardBrand): string {
	const names: Record<CardBrand, string> = {
		visa: "Visa",
		mastercard: "Mastercard",
		amex: "American Express",
		discover: "Discover",
		diners: "Diners Club",
		jcb: "JCB",
		unionpay: "UnionPay",
		unknown: "Unknown",
	};

	return names[brand];
}
