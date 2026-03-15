/**
 * Favicon utilities for fetching and displaying website icons
 */

import { normalizeServerUrl } from "./server-url";
import type { ItemCategory, ItemContextMetadata } from "./types";

export interface ItemWithFaviconContext extends ItemContextMetadata {
	url?: string;
	category?: ItemCategory;
}

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

export function getItemServerUrl(
	item: ItemContextMetadata | null | undefined,
	fallbackServerUrl?: string,
): string | undefined {
	return item?.serverUrl ?? item?.account?.serverUrl ?? fallbackServerUrl;
}

export function getItemFaviconUrl(
	item: ItemWithFaviconContext | null | undefined,
	size: 16 | 32 | 64 | 128 = 32,
	fallbackServerUrl?: string,
): string | null {
	if (!item?.url) {
		return null;
	}
	if (item.category && item.category !== "login") {
		return null;
	}

	return getFaviconUrl(
		item.url,
		size,
		getItemServerUrl(item, fallbackServerUrl),
	);
}
