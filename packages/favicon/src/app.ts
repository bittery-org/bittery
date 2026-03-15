import {
	incrementRateLimitWindow,
	RATE_LIMIT_NAMESPACE,
} from "@bittery/rate-limit";
import { Hono } from "hono";
import { z } from "zod";
import { FaviconLruCache } from "./cache";
import {
	fetchAndStoreFavicon,
	getFetchedFavicon,
	normalizeFaviconDomain,
} from "./service";

const CACHE_CONTROL_HEADER = "public, max-age=86400";
const FETCH_LIMIT_PER_MINUTE = 120;
const FETCH_WINDOW_MS = 60 * 1000;

const domainSchema = z.string().min(1).max(255);

function getWindowBucketStart(windowMs: number, now: Date): Date {
	return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function resolveSourceIp(headers: Headers): string | null {
	const cfIp = headers.get("CF-Connecting-IP")?.trim();
	if (cfIp) {
		return cfIp;
	}

	const forwardedFor = headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
	if (forwardedFor) {
		return forwardedFor;
	}

	const realIp = headers.get("X-Real-IP")?.trim();
	return realIp || null;
}

async function isRateLimited(sourceIp: string | null): Promise<boolean> {
	if (!sourceIp) {
		return false;
	}

	const now = new Date();
	const result = await incrementRateLimitWindow({
		namespace: RATE_LIMIT_NAMESPACE.faviconFetchSource,
		key: sourceIp,
		subject: sourceIp,
		now,
		windowStart: getWindowBucketStart(FETCH_WINDOW_MS, now),
		limit: FETCH_LIMIT_PER_MINUTE,
	});

	return !result.allowed;
}

const cacheEnabled = process.env.FAVICON_CACHE_ENABLED === "true";
const maxEntries = Number.parseInt(
	process.env.FAVICON_CACHE_MAX_ENTRIES ?? "10000",
	10,
);
const maxEntryBytes = Number.parseInt(
	process.env.FAVICON_CACHE_MAX_ENTRY_BYTES ?? "102400",
	10,
);
const maxTotalBytes = Number.parseInt(
	process.env.FAVICON_CACHE_MAX_TOTAL_BYTES ?? "52428800",
	10,
);

const memoryCache = cacheEnabled
	? new FaviconLruCache({
			maxEntries: Number.isFinite(maxEntries) ? maxEntries : 10_000,
			maxEntryBytes: Number.isFinite(maxEntryBytes)
				? maxEntryBytes
				: 100 * 1024,
			maxTotalBytes: Number.isFinite(maxTotalBytes)
				? maxTotalBytes
				: 50 * 1024 * 1024,
		})
	: null;

export const faviconApp = new Hono();

faviconApp.get("/:domain", async (c) => {
	const parsed = domainSchema.safeParse(c.req.param("domain"));
	if (!parsed.success) {
		return c.body(null, 404, {
			"Cache-Control": CACHE_CONTROL_HEADER,
		});
	}

	const normalizedDomain = normalizeFaviconDomain(parsed.data);
	if (!normalizedDomain) {
		return c.body(null, 404, {
			"Cache-Control": CACHE_CONTROL_HEADER,
		});
	}

	const sourceIp = resolveSourceIp(c.req.raw.headers);
	if (await isRateLimited(sourceIp)) {
		return c.text("Too many requests", 429, {
			"Cache-Control": CACHE_CONTROL_HEADER,
		});
	}

	const cached = memoryCache?.get(normalizedDomain);
	if (cached) {
		return c.body(new Uint8Array(cached.data), 200, {
			"Content-Type": cached.contentType,
			"Cache-Control": CACHE_CONTROL_HEADER,
		});
	}

	const inDatabase = await getFetchedFavicon(normalizedDomain);
	if (inDatabase) {
		memoryCache?.set(normalizedDomain, inDatabase.data, inDatabase.contentType);
		return c.body(new Uint8Array(inDatabase.data), 200, {
			"Content-Type": inDatabase.contentType,
			"Cache-Control": CACHE_CONTROL_HEADER,
		});
	}

	const fetched = await fetchAndStoreFavicon(normalizedDomain);
	if (!fetched) {
		return c.body(null, 404, {
			"Cache-Control": CACHE_CONTROL_HEADER,
		});
	}

	memoryCache?.set(normalizedDomain, fetched.data, fetched.contentType);
	return c.body(new Uint8Array(fetched.data), 200, {
		"Content-Type": fetched.contentType,
		"Cache-Control": CACHE_CONTROL_HEADER,
	});
});
