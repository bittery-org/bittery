import { db, favicon } from "@bittery/db";
import { and, eq, lt, or, sql } from "drizzle-orm";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOWNLOAD_BYTES = 1_000_000;
const MAX_FAILURE_BACKOFF_MINUTES = 7 * 24 * 60;
const MIN_FAILURE_BACKOFF_MINUTES = 10;

export interface FaviconImage {
	domain: string;
	data: Buffer;
	contentType: string;
}

function inferContentType(url: string): string {
	if (url.endsWith(".png")) return "image/png";
	if (url.endsWith(".svg")) return "image/svg+xml";
	if (url.endsWith(".ico")) return "image/x-icon";
	return "application/octet-stream";
}

function sanitizeContentType(contentType: string | null, fallbackUrl: string): string {
	if (!contentType) {
		return inferContentType(fallbackUrl);
	}
	return contentType.split(";")[0]?.trim().toLowerCase() || inferContentType(fallbackUrl);
}

function toBuffer(imageData: unknown): Buffer | null {
	if (Buffer.isBuffer(imageData)) {
		return imageData;
	}
	if (imageData instanceof Uint8Array) {
		return Buffer.from(imageData);
	}
	return null;
}

function computeFailureBackoffMinutes(failCount: number): number {
	const step = Math.max(0, failCount - 1);
	return Math.min(MAX_FAILURE_BACKOFF_MINUTES, MIN_FAILURE_BACKOFF_MINUTES * 2 ** step);
}

async function upsertPending(domain: string): Promise<void> {
	await db
		.insert(favicon)
		.values({
			domain,
			status: "pending",
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: favicon.domain,
			set: {
				status: "pending",
				updatedAt: new Date(),
			},
		});
}

async function markFetched(
	domain: string,
	data: Buffer,
	contentType: string,
): Promise<void> {
	const now = new Date();
	await db
		.update(favicon)
		.set({
			status: "fetched",
			imageData: data,
			contentType,
			fetchedAt: now,
			failedAt: null,
			failCount: 0,
			updatedAt: now,
		})
		.where(eq(favicon.domain, domain));
}

async function markFailed(domain: string): Promise<void> {
	const now = new Date();
	await db
		.insert(favicon)
		.values({
			domain,
			status: "failed",
			failedAt: now,
			failCount: 1,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: favicon.domain,
			set: {
				status: "failed",
				failedAt: now,
				failCount: sql`${favicon.failCount} + 1`,
				updatedAt: now,
			},
		});
}

async function fetchWithLimit(
	url: string,
	expectHtml: boolean,
): Promise<{ data: Buffer; contentType: string } | null> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		redirect: "follow",
	});

	if (!response.ok) {
		return null;
	}

	const contentType = sanitizeContentType(response.headers.get("content-type"), url);
	if (expectHtml) {
		if (!contentType.includes("text/html")) {
			return null;
		}
	} else if (!contentType.startsWith("image/")) {
		return null;
	}

	const arrayBuffer = await response.arrayBuffer();
	const data = Buffer.from(arrayBuffer);
	if (data.byteLength === 0 || data.byteLength > MAX_DOWNLOAD_BYTES) {
		return null;
	}

	return { data, contentType };
}

function extractIconLinks(html: string, baseUrl: string): string[] {
	const links: string[] = [];
	const linkTagRegex = /<link\b[^>]*>/gi;

	for (const match of html.matchAll(linkTagRegex)) {
		const tag = match[0];
		const relMatch = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i);
		if (!relMatch) {
			continue;
		}

		const relValue = relMatch[2]?.toLowerCase() ?? "";
		if (!relValue.includes("icon")) {
			continue;
		}

		const hrefMatch = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
		const href = hrefMatch?.[2]?.trim();
		if (!href) {
			continue;
		}

		try {
			const resolved = new URL(href, baseUrl);
			if (resolved.protocol === "http:" || resolved.protocol === "https:") {
				links.push(resolved.toString());
			}
		} catch {
			continue;
		}
	}

	return [...new Set(links)];
}

async function resolveCandidateUrls(domain: string): Promise<string[]> {
	const directFavicon = `https://${domain}/favicon.ico`;
	const homepageUrl = `https://${domain}/`;
	const appleTouchIcon = `https://${domain}/apple-touch-icon.png`;

	let htmlIconLinks: string[] = [];
	try {
		const htmlResponse = await fetchWithLimit(homepageUrl, true);
		if (htmlResponse) {
			htmlIconLinks = extractIconLinks(
				htmlResponse.data.toString("utf8"),
				homepageUrl,
			);
		}
	} catch {
		// Ignore homepage parsing failures and continue with fallback candidates.
	}

	return [directFavicon, ...htmlIconLinks, appleTouchIcon];
}

export function normalizeFaviconDomain(input: string): string | null {
	const candidate = input.trim().toLowerCase();
	if (!candidate || candidate.length > 255) {
		return null;
	}

	let hostname = "";
	try {
		const parsed = new URL(
			candidate.includes("://") ? candidate : `https://${candidate}`,
		);
		hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	} catch {
		return null;
	}

	if (!hostname || hostname.length > 253 || !/^[a-z0-9.-]+$/i.test(hostname)) {
		return null;
	}

	const labels = hostname.split(".");
	if (labels.some((label) => !label || label.length > 63)) {
		return null;
	}
	if (labels.some((label) => label.startsWith("-") || label.endsWith("-"))) {
		return null;
	}

	return hostname;
}

export async function getFetchedFavicon(domain: string): Promise<FaviconImage | null> {
	const existing = await db.query.favicon.findFirst({
		where: eq(favicon.domain, domain),
		columns: {
			domain: true,
			imageData: true,
			contentType: true,
			status: true,
		},
	});

	if (!existing || existing.status !== "fetched" || !existing.imageData) {
		return null;
	}

	const data = toBuffer(existing.imageData);
	if (!data) {
		return null;
	}

	return {
		domain,
		data,
		contentType: existing.contentType ?? "image/x-icon",
	};
}

export async function fetchAndStoreFavicon(
	domain: string,
): Promise<FaviconImage | null> {
	const existing = await db.query.favicon.findFirst({
		where: eq(favicon.domain, domain),
		columns: {
			domain: true,
			imageData: true,
			contentType: true,
			status: true,
			failedAt: true,
			failCount: true,
		},
	});

	if (existing?.status === "fetched" && existing.imageData) {
		const data = toBuffer(existing.imageData);
		if (data) {
			return {
				domain,
				data,
				contentType: existing.contentType ?? "image/x-icon",
			};
		}
	}

	if (existing?.status === "failed" && existing.failedAt) {
		const backoffMinutes = computeFailureBackoffMinutes(existing.failCount || 1);
		const retryAfter = new Date(
			existing.failedAt.getTime() + backoffMinutes * 60 * 1000,
		);
		if (retryAfter > new Date()) {
			return null;
		}
	}

	await upsertPending(domain);

	try {
		const candidates = await resolveCandidateUrls(domain);

		for (const candidate of candidates) {
			try {
				const result = await fetchWithLimit(candidate, false);
				if (!result) {
					continue;
				}

				await markFetched(domain, result.data, result.contentType);
				return {
					domain,
					data: result.data,
					contentType: result.contentType,
				};
			} catch {
				continue;
			}
		}

		await markFailed(domain);
		return null;
	} catch {
		await markFailed(domain);
		return null;
	}
}

export async function listDomainsToRefresh(
	limit: number,
	staleBefore: Date,
): Promise<string[]> {
	const rows = await db
		.select({ domain: favicon.domain })
		.from(favicon)
		.where(
			or(
				and(eq(favicon.status, "fetched"), lt(favicon.fetchedAt, staleBefore)),
				eq(favicon.status, "failed"),
			),
		)
		.limit(limit);

	return rows.map((row) => row.domain);
}
