/**
 * Relevance ranking for autofill suggestions.
 *
 * `hostnameMatches` answers a yes/no question — "may this item be offered for
 * this page?" — and answers it generously: anything sharing a base domain
 * qualifies, so an item saved for `shop.example.com` is offered on
 * `login.example.com`. That is the right call for *inclusion*, but it left the
 * list unordered, so an unrelated sibling subdomain could sit above the exact
 * match for the page the user is actually on.
 *
 * This module adds the missing ordering: how *well* an item matches, most
 * specific first.
 */

import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { getBaseDomain, normalizeHost, parseHostname } from "./hostname";

/**
 * Match quality of a single item URL against the page's hostname.
 * Higher is a better match; `NONE` means the item should not be offered at all.
 */
export const UrlMatchScore = {
	/** Same hostname, e.g. item `app.foo.com` on page `app.foo.com`. */
	EXACT: 100,
	/** Item is the parent domain of the page, e.g. `foo.com` on `login.foo.com`. */
	PARENT_DOMAIN: 80,
	/** Item is a subdomain of the page, e.g. `login.foo.com` on `foo.com`. */
	SUBDOMAIN: 70,
	/** Only the registrable domain matches, e.g. `mail.foo.com` on `shop.foo.com`. */
	SIBLING_DOMAIN: 40,
	NONE: 0,
} as const;

/** Every URL an item is associated with, de-duplicated and non-empty. */
export function getItemUrls(
	item: Pick<DecryptedItemWithContext, "url" | "urls">,
): string[] {
	const all = [item.url, ...(item.urls ?? [])].filter(
		(value): value is string => Boolean(value?.trim()),
	);
	return [...new Set(all)];
}

/** Score one URL against a target hostname. */
export function scoreUrlMatch(url: string, targetHostname: string): number {
	const itemHost = parseHostname(url);
	const target = normalizeHost(targetHostname);
	if (!itemHost || !target) return UrlMatchScore.NONE;

	if (itemHost === target) return UrlMatchScore.EXACT;
	if (target.endsWith(`.${itemHost}`)) return UrlMatchScore.PARENT_DOMAIN;
	if (itemHost.endsWith(`.${target}`)) return UrlMatchScore.SUBDOMAIN;
	if (getBaseDomain(itemHost) === getBaseDomain(target)) {
		return UrlMatchScore.SIBLING_DOMAIN;
	}

	return UrlMatchScore.NONE;
}

/**
 * Best match across all of an item's URLs.
 *
 * Items can carry a `urls` array in addition to the primary `url`; only the
 * primary one used to be considered, so an item explicitly associated with the
 * current site through a secondary URL was never suggested.
 */
export function scoreItemForHostname(
	item: Pick<DecryptedItemWithContext, "url" | "urls">,
	targetHostname: string,
): number {
	let best: number = UrlMatchScore.NONE;
	for (const url of getItemUrls(item)) {
		const score = scoreUrlMatch(url, targetHostname);
		if (score > best) best = score;
		if (best === UrlMatchScore.EXACT) break;
	}
	return best;
}

function timestamp(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/** Favourites first, then most recently updated, then alphabetical. */
function compareByUsefulness(
	a: DecryptedItemWithContext,
	b: DecryptedItemWithContext,
): number {
	if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;

	const recency = timestamp(b.updatedAt) - timestamp(a.updatedAt);
	if (recency !== 0) return recency;

	return (a.title ?? "").localeCompare(b.title ?? "");
}

/**
 * Filter items to those relevant for `hostname` and order them by how
 * specifically they match it.
 */
export function rankItemsForHostname<T extends DecryptedItemWithContext>(
	items: T[],
	hostname: string,
): T[] {
	return items
		.map((item) => ({ item, score: scoreItemForHostname(item, hostname) }))
		.filter(({ score }) => score > UrlMatchScore.NONE)
		.sort((a, b) =>
			b.score !== a.score
				? b.score - a.score
				: compareByUsefulness(a.item, b.item),
		)
		.map(({ item }) => item);
}

/** Order items that have no URL dimension (credit cards, identities). */
export function rankItemsByUsefulness<T extends DecryptedItemWithContext>(
	items: T[],
): T[] {
	return [...items].sort(compareByUsefulness);
}

function normalize(value: string | null | undefined): string {
	return (value ?? "").toLowerCase().trim();
}

/**
 * How well an item matches a typed query. A prefix match is what the user
 * almost always means, so it outranks a substring match anywhere else.
 */
export function scoreQueryMatch(
	fields: Array<{ value: string | null | undefined; weight: number }>,
	query: string,
): number {
	const needle = normalize(query);
	if (!needle) return 1;

	let best = 0;
	for (const { value, weight } of fields) {
		const haystack = normalize(value);
		if (!haystack) continue;

		if (haystack === needle) {
			best = Math.max(best, weight + 20);
		} else if (haystack.startsWith(needle)) {
			best = Math.max(best, weight + 10);
		} else if (haystack.includes(needle)) {
			best = Math.max(best, weight);
		}
	}
	return best;
}

/**
 * Sort by query relevance while preserving the incoming order for ties.
 *
 * The incoming order is the hostname ranking above, so an exact-domain item
 * stays ahead of a sibling-domain item when both match the query equally well.
 * `Array.prototype.sort` is specified as stable, which is what makes this work.
 */
export function rankByQuery<T>(
	items: T[],
	query: string,
	getFields: (
		item: T,
	) => Array<{ value: string | null | undefined; weight: number }>,
): T[] {
	if (!query.trim()) return items;

	return items
		.map((item) => ({ item, score: scoreQueryMatch(getFields(item), query) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.map(({ item }) => item);
}
