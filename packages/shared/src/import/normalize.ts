import { isValidBase32, parseOtpAuthUri } from "../totp";
import type { TotpAlgorithm, TotpDigits } from "../types";

/**
 * Shared normalization helpers for import providers.
 *
 * These deliberately live outside any single provider: every CSV-based provider
 * added after Bitwarden needs the same URL, expiry-date, TOTP and custom-field
 * handling, and duplicating them is how the two implementations drift apart.
 */

export interface ParsedTotpValue {
	secret: string;
	issuer?: string;
	accountName?: string;
	algorithm?: TotpAlgorithm;
	digits?: TotpDigits;
	period?: number;
}

/**
 * Turn a loosely formatted URL into something a browser can open.
 * Values that are not URL-shaped are returned unchanged rather than dropped.
 */
export function normalizeUrl(value: string): string | null {
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

/**
 * Build the `MM/YYYY` expiry string Bittery stores from a separate month and
 * year, as exported by Bitwarden JSON cards.
 */
export function normalizeExpiryDate(
	month: string | number | undefined | null,
	year: string | number | undefined | null,
): string | undefined {
	const monthRaw = `${month ?? ""}`.trim();
	const yearRaw = `${year ?? ""}`.trim();

	// `MM/YYYY` is only meaningful with both halves. A partial or out-of-range
	// value is dropped rather than stored as an expiry Bittery cannot render.
	if (!/^\d{1,2}$/.test(monthRaw) || !/^\d{2}(\d{2})?$/.test(yearRaw)) {
		return undefined;
	}

	const monthNumber = Number.parseInt(monthRaw, 10);
	if (monthNumber < 1 || monthNumber > 12) {
		return undefined;
	}

	// Two-digit years are exported by some products; expand them into this century.
	const fullYear = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;

	return `${String(monthNumber).padStart(2, "0")}/${fullYear}`;
}

/**
 * Parse a TOTP value that may be either a bare base32 seed or an `otpauth://`
 * URI. Returns null when nothing usable can be extracted, so callers can raise
 * an explicit lossiness warning instead of importing a broken secret.
 */
export function parseTotpValue(raw: string): ParsedTotpValue | null {
	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	if (trimmed.toLowerCase().startsWith("otpauth://")) {
		let parsed: ReturnType<typeof parseOtpAuthUri>;
		try {
			parsed = parseOtpAuthUri(trimmed);
		} catch {
			return null;
		}

		if (parsed.type !== "totp") {
			return null;
		}

		const secret = parsed.secret.replace(/\s/g, "");
		if (!isValidBase32(secret)) {
			return null;
		}

		return {
			secret,
			...(parsed.issuer ? { issuer: parsed.issuer } : {}),
			...(parsed.accountName ? { accountName: parsed.accountName } : {}),
			...(parsed.algorithm ? { algorithm: parsed.algorithm } : {}),
			...(parsed.digits ? { digits: parsed.digits } : {}),
			...(parsed.period && parsed.period > 0 ? { period: parsed.period } : {}),
		};
	}

	// Bitwarden allows "steam://SEED" and similar prefixed seeds; only plain
	// base32 is representable in Bittery today.
	const secret = trimmed.replace(/\s/g, "");
	if (!isValidBase32(secret)) {
		return null;
	}

	return { secret };
}

/**
 * Deterministic custom-field id, matching the convention already used by the
 * 1PUX provider. Never derived from time or randomness so previews and tests
 * are reproducible.
 */
export function buildCustomFieldId(itemId: string, index: number): string {
	return `${itemId}-custom-${index + 1}`;
}
