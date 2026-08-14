/**
 * Hostname Utilities
 *
 * Shared across background and popup (`pages/vault.tsx`) surfaces for
 * hostname normalization and matching (autofill, passkeys, save prompts).
 *
 * This file owns the canonical answer to "may this saved credential be offered
 * on this site?". The Android credential provider re-implements it in Kotlin
 * (`expo.modules.credentialprovider.domain.DomainMatch`) because a headless OS
 * extension process cannot reach the JS module; the two are pinned together by
 * `domain-matching.vectors.json`, which both sides' tests assert against.
 */

/**
 * Multi-label public suffixes.
 *
 * Without these, "last two labels" makes every `*.co.uk` site share a base
 * domain, so a bbc.co.uk credential is offered on itv.co.uk. The full Public
 * Suffix List is ~10,000 entries and needs periodic updates; this is the
 * high-traffic subset, kept small enough to restate in Kotlin by hand. An
 * unlisted suffix degrades to the old last-two-labels behaviour rather than
 * failing, so adding one is always safe.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
	// United Kingdom
	"co.uk",
	"org.uk",
	"me.uk",
	"ltd.uk",
	"plc.uk",
	"net.uk",
	"sch.uk",
	"ac.uk",
	"gov.uk",
	"nhs.uk",
	// Australia / New Zealand
	"com.au",
	"net.au",
	"org.au",
	"edu.au",
	"gov.au",
	"id.au",
	"co.nz",
	"net.nz",
	"org.nz",
	"govt.nz",
	"ac.nz",
	// Japan / Korea / Taiwan / China / Hong Kong / Singapore
	"co.jp",
	"ne.jp",
	"or.jp",
	"ac.jp",
	"go.jp",
	"co.kr",
	"or.kr",
	"com.tw",
	"com.cn",
	"net.cn",
	"org.cn",
	"gov.cn",
	"com.hk",
	"com.sg",
	// South / Southeast Asia
	"co.in",
	"net.in",
	"org.in",
	"gov.in",
	"ac.in",
	"com.my",
	"com.ph",
	"com.pk",
	"co.th",
	"co.id",
	"com.vn",
	"com.bd",
	// Americas
	"com.br",
	"net.br",
	"org.br",
	"gov.br",
	"com.mx",
	"com.ar",
	"com.co",
	"com.pe",
	"com.uy",
	"com.ve",
	"com.ec",
	"com.bo",
	"com.py",
	"com.do",
	"com.gt",
	"com.pa",
	"co.cr",
	// Europe, Middle East, Africa, Turkey, Russia
	"co.za",
	"org.za",
	"net.za",
	"gov.za",
	"com.ng",
	"com.eg",
	"com.gh",
	"co.ke",
	"co.il",
	"com.tr",
	"gov.tr",
	"edu.tr",
	"com.sa",
	"com.ua",
	"com.ru",
	"com.pl",
	"com.gr",
	"com.es",
	"com.pt",
	"com.cy",
	"com.hr",
	"co.rs",
]);

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Reduce any of a URL, an origin, an rpId or a bare host to a comparable host:
 * lowercased, with scheme, userinfo, port, path/query/fragment and boundary dots
 * removed. Non-hosts (an Android package name, say) pass through unchanged so
 * callers can still compare them for equality.
 */
export function normalizeHost(value: string | null | undefined): string {
	if (!value) return "";

	let host = value.trim().toLowerCase().replace(SCHEME, "");
	const boundary = host.search(/[/?#]/);
	if (boundary >= 0) host = host.slice(0, boundary);

	const userinfo = host.lastIndexOf("@");
	if (userinfo >= 0) host = host.slice(userinfo + 1);

	if (host.startsWith("[")) {
		// IPv6 literal: everything after the closing bracket is the port.
		const close = host.indexOf("]");
		if (close >= 0) host = host.slice(0, close + 1);
	} else {
		const colon = host.lastIndexOf(":");
		if (colon >= 0 && /^\d+$/.test(host.slice(colon + 1))) {
			host = host.slice(0, colon);
		}
	}

	return host.replace(/^\.+/, "").replace(/\.+$/, "");
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

/**
 * The registrable domain: the public suffix plus one label — `bbc.co.uk` for
 * `news.bbc.co.uk`, `example.com` for `a.b.example.com`. This is the unit two
 * sibling subdomains have to share before their credentials are interchangeable.
 */
export function registrableDomain(host: string): string {
	const normalized = normalizeHost(host);
	if (!normalized || IPV4.test(normalized) || normalized.startsWith("[")) {
		return normalized;
	}

	const labels = normalized.split(".");
	let suffixLabels = 1;
	for (let index = 1; index < labels.length; index++) {
		const candidate = labels.slice(index).join(".");
		if (MULTI_LABEL_PUBLIC_SUFFIXES.has(candidate)) {
			suffixLabels = Math.max(suffixLabels, labels.length - index);
		}
	}

	if (labels.length <= suffixLabels) return normalized;
	return labels.slice(labels.length - suffixLabels - 1).join(".");
}

/**
 * The domain keys a host is indexed and queried under. Android's `item_domains`
 * table matches by intersecting an item's indexed keys with a target's queried
 * keys, which reproduces `hostnameMatches` in SQL; the extension has no such
 * table but exports this so the shared vectors can assert the two agree.
 */
export function domainLookupKeys(host: string): string[] {
	const normalized = normalizeHost(host);
	if (!normalized) return [];
	const registrable = registrableDomain(normalized);
	return registrable === normalized ? [normalized] : [normalized, registrable];
}

/**
 * True when the two hosts are the same site: identical, one a subdomain of the
 * other, or siblings under one registrable domain.
 *
 * Accepts a URL or a bare host on either side, and is symmetric.
 */
export function hostnameMatches(
	itemUrl: string | undefined,
	targetHostname: string,
): boolean {
	const item = normalizeHost(itemUrl);
	const target = normalizeHost(targetHostname);
	if (!item || !target) return false;

	if (item === target) return true;
	if (item.endsWith(`.${target}`) || target.endsWith(`.${item}`)) return true;

	return registrableDomain(item) === registrableDomain(target);
}
