import type { RateLimitAdapter } from "./types";

type AdapterMode = "auto" | "postgres" | "redis" | "valkey";

function resolveMode(): AdapterMode {
	const raw = (process.env.RATE_LIMIT_ADAPTER ?? "auto")
		.trim()
		.toLowerCase();
	if (raw === "postgres" || raw === "redis" || raw === "valkey") {
		return raw;
	}
	return "auto";
}

function resolveRedisUrl(): string | null {
	const explicit = process.env.RATE_LIMIT_REDIS_URL?.trim();
	if (explicit) {
		return explicit;
	}
	const shared = process.env.REDIS_URL?.trim();
	return shared || null;
}

/**
 * Adapter selection strategy:
 * - RATE_LIMIT_ADAPTER=postgres  -> Postgres
 * - RATE_LIMIT_ADAPTER=redis|valkey -> Redis URL is required
 * - RATE_LIMIT_ADAPTER=auto (default):
 *   - RATE_LIMIT_REDIS_URL / REDIS_URL set -> Redis
 *   - otherwise -> Postgres
 */
export async function createRateLimitAdapter(): Promise<RateLimitAdapter> {
	const mode = resolveMode();
	const redisUrl = resolveRedisUrl();
	const shouldUseRedis =
		mode === "redis" || mode === "valkey" || (mode === "auto" && !!redisUrl);

	if (shouldUseRedis) {
		if (!redisUrl) {
			throw new Error(
				"RATE_LIMIT_ADAPTER is redis/valkey but no RATE_LIMIT_REDIS_URL (or REDIS_URL) is configured",
			);
		}

		try {
			const { RedisRateLimitAdapter } = await import("./adapters/redis");
			console.log("[rate-limit] Using Redis/Valkey adapter");
			return new RedisRateLimitAdapter(redisUrl);
		} catch (error) {
			if (mode !== "auto") {
				throw error;
			}
			console.warn(
				"[rate-limit] Failed to initialize Redis adapter, falling back to Postgres:",
				error,
			);
		}
	}

	const { PostgresRateLimitAdapter } = await import("./adapters/postgres");
	console.log("[rate-limit] Using Postgres adapter");
	return new PostgresRateLimitAdapter();
}
