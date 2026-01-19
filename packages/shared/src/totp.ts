/**
 * TOTP (Time-Based One-Time Password) Implementation
 * Based on RFC 6238: https://tools.ietf.org/html/rfc6238
 * and RFC 4226 (HOTP): https://tools.ietf.org/html/rfc4226
 */
/** biome-ignore-all lint/style/noNonNullAssertion: Its fine here */

import type { TotpAlgorithm, TotpDigits } from "./types";

/**
 * TOTP configuration options
 */
export interface TotpOptions {
	/** The shared secret key (base32 encoded) */
	secret: string;
	/** Hash algorithm (default: SHA1) */
	algorithm?: TotpAlgorithm;
	/** Number of digits in the code (default: 6) */
	digits?: TotpDigits;
	/** Time step in seconds (default: 30) */
	period?: number;
	/** Issuer name for the authenticator */
	issuer?: string;
	/** Account name for the authenticator */
	accountName?: string;
}

/**
 * Result of generating a TOTP code
 */
export interface TotpResult {
	/** The generated TOTP code */
	code: string;
	/** Seconds remaining until the code expires */
	remainingSeconds: number;
	/** Total period in seconds */
	period: number;
	/** Progress percentage (0-100) of time elapsed in current period */
	progress: number;
}

/**
 * Parsed otpauth URI
 */
export interface ParsedOtpAuthUri {
	type: "totp" | "hotp";
	secret: string;
	issuer?: string;
	accountName?: string;
	algorithm?: TotpAlgorithm;
	digits?: TotpDigits;
	period?: number;
	counter?: number;
}

// Base32 alphabet (RFC 4648)
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a base32-encoded string to Uint8Array
 */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
	// Remove spaces and convert to uppercase
	const sanitized = input.replace(/\s/g, "").toUpperCase();

	// Remove padding
	const noPadding = sanitized.replace(/=+$/, "");

	if (noPadding.length === 0) {
		return new Uint8Array(0) as Uint8Array<ArrayBuffer>;
	}

	// Validate characters
	for (const char of noPadding) {
		if (!BASE32_ALPHABET.includes(char)) {
			throw new Error(`Invalid base32 character: ${char}`);
		}
	}

	// Calculate output length
	const outputLength = Math.floor((noPadding.length * 5) / 8);
	const output = new Uint8Array(outputLength);

	let buffer = 0;
	let bitsLeft = 0;
	let outputIndex = 0;

	for (const char of noPadding) {
		const value = BASE32_ALPHABET.indexOf(char);
		buffer = (buffer << 5) | value;
		bitsLeft += 5;

		if (bitsLeft >= 8) {
			bitsLeft -= 8;
			output[outputIndex++] = (buffer >> bitsLeft) & 0xff;
		}
	}

	return output;
}

/**
 * Encode a Uint8Array to base32 string
 */
export function base32Encode(input: Uint8Array<ArrayBuffer>): string {
	if (input.length === 0) {
		return "";
	}

	let result = "";
	let buffer = 0;
	let bitsLeft = 0;

	for (const byte of input) {
		buffer = (buffer << 8) | byte;
		bitsLeft += 8;

		while (bitsLeft >= 5) {
			bitsLeft -= 5;
			result += BASE32_ALPHABET[(buffer >> bitsLeft) & 0x1f];
		}
	}

	// Handle remaining bits
	if (bitsLeft > 0) {
		result += BASE32_ALPHABET[(buffer << (5 - bitsLeft)) & 0x1f];
	}

	return result;
}

/**
 * Validate a base32-encoded secret
 */
export function isValidBase32(input: string): boolean {
	try {
		const sanitized = input.replace(/\s/g, "").toUpperCase().replace(/=+$/, "");
		if (sanitized.length === 0) return false;

		for (const char of sanitized) {
			if (!BASE32_ALPHABET.includes(char)) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the algorithm name for Web Crypto API
 */
function getWebCryptoAlgorithm(algorithm: TotpAlgorithm): string {
	switch (algorithm) {
		case "SHA256":
			return "SHA-256";
		case "SHA512":
			return "SHA-512";
		default:
			return "SHA-1";
	}
}

/**
 * Generate HMAC using Web Crypto API
 */
async function hmac(
	algorithm: TotpAlgorithm,
	key: Uint8Array<ArrayBuffer>,
	message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: "HMAC", hash: getWebCryptoAlgorithm(algorithm) },
		false,
		["sign"],
	);

	const signature = await crypto.subtle.sign("HMAC", cryptoKey, message);
	return new Uint8Array(signature);
}

/**
 * Convert a number to an 8-byte big-endian Uint8Array
 */
function numberToBytes(num: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(8) as Uint8Array<ArrayBuffer>;
	let remaining = num;

	for (let i = 7; i >= 0; i--) {
		bytes[i] = remaining & 0xff;
		remaining = Math.floor(remaining / 256);
	}

	return bytes;
}

/**
 * Generate HOTP code (RFC 4226)
 */
async function generateHotp(
	secret: Uint8Array<ArrayBuffer>,
	counter: number,
	algorithm: TotpAlgorithm = "SHA1",
	digits: TotpDigits = 6,
): Promise<string> {
	// Step 1: Generate HMAC-SHA hash
	const counterBytes = numberToBytes(counter);
	const hash = await hmac(algorithm, secret, counterBytes);

	// Step 2: Dynamic truncation
	const offset = hash[hash.length - 1]! & 0x0f;
	const binary =
		((hash[offset]! & 0x7f) << 24) |
		((hash[offset + 1]! & 0xff) << 16) |
		((hash[offset + 2]! & 0xff) << 8) |
		(hash[offset + 3]! & 0xff);

	// Step 3: Compute HOTP value
	const otp = binary % 10 ** digits;

	// Pad with leading zeros if necessary
	return otp.toString().padStart(digits, "0");
}

/**
 * Generate a TOTP code for the current time
 */
export async function generateTotp(options: TotpOptions): Promise<TotpResult> {
	const { secret, algorithm = "SHA1", digits = 6, period = 30 } = options;

	// Decode the base32 secret
	const secretBytes = base32Decode(secret);

	// Calculate time counter
	const now = Math.floor(Date.now() / 1000);
	const counter = Math.floor(now / period);

	// Generate HOTP code
	const code = await generateHotp(secretBytes, counter, algorithm, digits);

	// Calculate remaining seconds
	const elapsed = now % period;
	const remainingSeconds = period - elapsed;
	const progress = (elapsed / period) * 100;

	return {
		code,
		remainingSeconds,
		period,
		progress,
	};
}

/**
 * Generate a TOTP code for a specific timestamp (useful for testing)
 */
export async function generateTotpAt(
	options: TotpOptions,
	timestamp: number,
): Promise<string> {
	const { secret, algorithm = "SHA1", digits = 6, period = 30 } = options;

	const secretBytes = base32Decode(secret);
	const counter = Math.floor(timestamp / period);

	return generateHotp(secretBytes, counter, algorithm, digits);
}

/**
 * Verify a TOTP code with optional time skew tolerance
 * Returns true if the code is valid within the tolerance window
 */
export async function verifyTotp(
	code: string,
	options: TotpOptions,
	tolerance = 1,
): Promise<boolean> {
	const { secret, algorithm = "SHA1", digits = 6, period = 30 } = options;

	const secretBytes = base32Decode(secret);
	const now = Math.floor(Date.now() / 1000);
	const currentCounter = Math.floor(now / period);

	// Check within tolerance window
	for (let i = -tolerance; i <= tolerance; i++) {
		const expectedCode = await generateHotp(
			secretBytes,
			currentCounter + i,
			algorithm,
			digits,
		);
		if (expectedCode === code) {
			return true;
		}
	}

	return false;
}

/**
 * Parse an otpauth:// URI (RFC 6238)
 * Format: otpauth://totp/ISSUER:ACCOUNT?secret=SECRET&issuer=ISSUER&algorithm=SHA1&digits=6&period=30
 */
export function parseOtpAuthUri(uri: string): ParsedOtpAuthUri {
	const url = new URL(uri);

	if (url.protocol !== "otpauth:") {
		throw new Error("Invalid URI scheme. Expected otpauth://");
	}

	const type = url.hostname as "totp" | "hotp";
	if (type !== "totp" && type !== "hotp") {
		throw new Error("Invalid OTP type. Expected totp or hotp.");
	}

	// Parse label (format: "issuer:account" or just "account")
	const label = decodeURIComponent(url.pathname.slice(1)); // Remove leading /
	let issuer: string | undefined;
	let accountName: string;

	if (label.includes(":")) {
		const [issuerPart, ...accountParts] = label.split(":");
		issuer = issuerPart;
		accountName = accountParts.join(":");
	} else {
		accountName = label;
	}

	// Get parameters
	const params = url.searchParams;
	const secret = params.get("secret");

	if (!secret) {
		throw new Error("Missing required 'secret' parameter");
	}

	// Issuer from params takes precedence
	const issuerParam = params.get("issuer");
	if (issuerParam) {
		issuer = issuerParam;
	}

	const algorithmParam = params.get("algorithm")?.toUpperCase();
	let algorithm: TotpAlgorithm | undefined;
	if (
		algorithmParam === "SHA1" ||
		algorithmParam === "SHA256" ||
		algorithmParam === "SHA512"
	) {
		algorithm = algorithmParam;
	}

	const digitsParam = params.get("digits");
	let digits: TotpDigits | undefined;
	if (digitsParam) {
		const parsedDigits = Number.parseInt(digitsParam, 10);
		if (parsedDigits === 6 || parsedDigits === 7 || parsedDigits === 8) {
			digits = parsedDigits;
		}
	}

	const periodParam = params.get("period");
	const period = periodParam ? Number.parseInt(periodParam, 10) : undefined;

	const counterParam = params.get("counter");
	const counter = counterParam ? Number.parseInt(counterParam, 10) : undefined;

	return {
		type,
		secret,
		issuer,
		accountName,
		algorithm,
		digits,
		period,
		counter,
	};
}

/**
 * Generate an otpauth:// URI from TOTP options
 */
export function generateOtpAuthUri(options: TotpOptions): string {
	const {
		secret,
		algorithm = "SHA1",
		digits = 6,
		period = 30,
		issuer,
		accountName,
	} = options;

	// Build label
	let label = "";
	if (issuer && accountName) {
		label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
	} else if (accountName) {
		label = encodeURIComponent(accountName);
	} else if (issuer) {
		label = encodeURIComponent(issuer);
	}

	const url = new URL(`otpauth://totp/${label}`);
	url.searchParams.set("secret", secret.replace(/\s/g, "").toUpperCase());

	if (issuer) {
		url.searchParams.set("issuer", issuer);
	}

	if (algorithm !== "SHA1") {
		url.searchParams.set("algorithm", algorithm);
	}

	if (digits !== 6) {
		url.searchParams.set("digits", digits.toString());
	}

	if (period !== 30) {
		url.searchParams.set("period", period.toString());
	}

	return url.toString();
}

/**
 * Generate a random base32-encoded secret
 */
export function generateTotpSecret(length = 20): string {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return base32Encode(bytes);
}

/**
 * Format a base32 secret for display (groups of 4 characters)
 */
export function formatSecretForDisplay(secret: string): string {
	const clean = secret.replace(/\s/g, "").toUpperCase();
	const groups = clean.match(/.{1,4}/g) || [];
	return groups.join(" ");
}
