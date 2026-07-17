/**
 * Hostname Utilities
 *
 * Shared across background and popup (`pages/vault.tsx`) surfaces for
 * hostname normalization and matching (autofill, passkeys, save prompts).
 */

/** Trim, lowercase, and strip leading/trailing dots from a hostname. */
export function normalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

/**
 * Parse a URL (or bare hostname) into a normalized hostname, returning
 * `null` if the value cannot be parsed as a URL.
 */
export function parseHostname(urlValue: string): string | null {
	try {
		const parsed = new URL(
			urlValue.startsWith("http://") || urlValue.startsWith("https://")
				? urlValue
				: `https://${urlValue}`,
		);
		return normalizeHost(parsed.hostname);
	} catch {
		return null;
	}
}

/**
 * Extract the raw (non-normalized) hostname from a URL, returning the
 * original input unchanged if it cannot be parsed as a URL.
 */
export function extractHostname(url: string): string {
	try {
		const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
		return urlObj.hostname;
	} catch {
		return url;
	}
}

/** Get the registrable "base domain" (last two labels) of a hostname. */
export function getBaseDomain(host: string): string {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

/**
 * True when `itemUrl`'s hostname matches `targetHostname` exactly, is a
 * subdomain (or superdomain) of it, or shares the same base domain.
 */
export function hostnameMatches(
	itemUrl: string | undefined,
	targetHostname: string,
): boolean {
	if (!itemUrl) return false;

	try {
		const itemUrlObj = new URL(
			itemUrl.startsWith("http") ? itemUrl : `https://${itemUrl}`,
		);
		const itemHostname = itemUrlObj.hostname;

		if (itemHostname === targetHostname) return true;

		if (
			itemHostname.endsWith(`.${targetHostname}`) ||
			targetHostname.endsWith(`.${itemHostname}`)
		) {
			return true;
		}

		const itemBaseDomain = getBaseDomain(itemHostname);
		const hostnameBaseDomain = getBaseDomain(targetHostname);

		return itemBaseDomain === hostnameBaseDomain;
	} catch {
		return false;
	}
}
