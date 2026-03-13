/**
 * Favicon utilities for fetching and displaying website icons
 */

import { normalizeServerUrl } from "./server-url";

/**
 * Extract domain from a URL
 */
export function getDomainFromUrl(url: string): string | null {
	try {
		const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
		return urlObj.hostname;
	} catch {
		return null;
	}
}

/**
 * Get favicon URL for a given website URL
 * Uses the Bittery favicon endpoint hosted on the configured server URL
 */
export function getFaviconUrl(
	url: string,
	_size: 16 | 32 | 64 | 128 = 32,
	serverUrl?: string,
): string | null {
	const domain = getDomainFromUrl(url);
	if (!domain) return null;
	const normalizedServerUrl = normalizeServerUrl(serverUrl ?? "");
	if (!normalizedServerUrl) return null;

	return `${normalizedServerUrl}/favicon/${encodeURIComponent(domain)}`;
}
