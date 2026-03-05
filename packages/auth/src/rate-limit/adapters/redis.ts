import { formatLocalDateKey, secondsUntilNextLocalDay } from "../constants";
import type {
	FailureBackoffInput,
	RateLimitAdapter,
	RateLimitState,
	WindowIncrementInput,
	WindowIncrementResult,
} from "../types";

interface RedisStatePayload {
	namespace: string;
	key: string;
	subject: string | null;
	attempts: number;
	count: number;
	lockedUntilMs: number | null;
	windowStartAtMs: number | null;
}

/**
 * Redis/Valkey adapter backed by Bun's RedisClient.
 */
export class RedisRateLimitAdapter implements RateLimitAdapter {
	private redis: {
		get(key: string): Promise<string | null>;
		set(key: string, value: string): Promise<unknown>;
		del(key: string): Promise<unknown>;
		incr(key: string): Promise<number | string>;
		expire(key: string, seconds: number): Promise<unknown>;
		close(): void;
		keys?: (pattern: string) => Promise<string[]>;
	};

	constructor(redisUrl: string) {
		const bunGlobal = globalThis as typeof globalThis & {
			Bun?: { RedisClient?: new (url: string) => unknown };
		};
		const { RedisClient } = bunGlobal.Bun ?? {};
		if (!RedisClient) {
			throw new Error(
				"RedisRateLimitAdapter requires Bun runtime with RedisClient support",
			);
		}
		this.redis = new RedisClient(redisUrl) as unknown as typeof this.redis;
	}

	async get(namespace: string, key: string): Promise<RateLimitState | null> {
		const redisKey = this.getStateKey(namespace, key);
		const payload = await this.redis.get(redisKey);
		if (!payload) {
			return null;
		}

		try {
			const parsed = JSON.parse(payload) as RedisStatePayload;
			return {
				namespace: parsed.namespace,
				key: parsed.key,
				subject: parsed.subject,
				attempts: parsed.attempts ?? 0,
				count: parsed.count ?? 0,
				lockedUntil:
					typeof parsed.lockedUntilMs === "number"
						? new Date(parsed.lockedUntilMs)
						: null,
				windowStartAt:
					typeof parsed.windowStartAtMs === "number"
						? new Date(parsed.windowStartAtMs)
						: null,
			};
		} catch {
			return null;
		}
	}

	async recordFailure(input: FailureBackoffInput): Promise<RateLimitState> {
		const current = await this.get(input.namespace, input.key);
		const attempts = (current?.attempts ?? 0) + 1;

		let lockedUntil: Date | null = null;
		if (attempts >= input.freeAttempts) {
			const lockMinutes = Math.min(
				input.maxLockMinutes,
				2 ** (attempts - input.freeAttempts),
			);
			lockedUntil = new Date(input.now.getTime() + lockMinutes * 60 * 1000);
		}

		const payload: RedisStatePayload = {
			namespace: input.namespace,
			key: input.key,
			subject: input.subject,
			attempts,
			count: current?.count ?? 0,
			lockedUntilMs: lockedUntil ? lockedUntil.getTime() : null,
			windowStartAtMs: current?.windowStartAt
				? current.windowStartAt.getTime()
				: null,
		};

		const redisKey = this.getStateKey(input.namespace, input.key);
		await this.redis.set(redisKey, JSON.stringify(payload));

		const ttlSeconds = lockedUntil
			? Math.max(
					3600,
					Math.ceil((lockedUntil.getTime() - input.now.getTime()) / 1000) +
						3600,
				)
			: 24 * 60 * 60;
		await this.redis.expire(redisKey, ttlSeconds);

		return {
			namespace: input.namespace,
			key: input.key,
			subject: input.subject,
			attempts,
			count: payload.count,
			lockedUntil,
			windowStartAt: current?.windowStartAt ?? null,
		};
	}

	async clear(namespace: string, key: string): Promise<void> {
		await this.redis.del(this.getStateKey(namespace, key));
	}

	async clearBySubject(namespace: string, subject: string): Promise<void> {
		if (typeof this.redis.keys !== "function") {
			return;
		}

		const keys = await this.redis.keys(this.getStatePattern(namespace));
		if (keys.length === 0) {
			return;
		}

		await Promise.all(
			keys.map(async (redisKey) => {
				const payload = await this.redis.get(redisKey);
				if (!payload) return;
				try {
					const parsed = JSON.parse(payload) as RedisStatePayload;
					if (parsed.subject === subject) {
						await this.redis.del(redisKey);
					}
				} catch {
					// Ignore malformed payloads and continue.
				}
			}),
		);
	}

	async incrementWithinWindow(
		input: WindowIncrementInput,
	): Promise<WindowIncrementResult> {
		const dateKey = formatLocalDateKey(input.windowStart);
		const redisKey = this.getWindowKey(input.namespace, dateKey, input.key);
		const nextValue = await this.redis.incr(redisKey);
		const count = Number(nextValue);

		if (count === 1) {
			await this.redis.expire(
				redisKey,
				secondsUntilNextLocalDay(input.now) + 60 * 60,
			);
		}

		return {
			allowed: count <= input.limit,
			count,
			limit: input.limit,
		};
	}

	async close(): Promise<void> {
		this.redis.close();
	}

	private getStateKey(namespace: string, key: string): string {
		return `bittery:rl:state:${namespace}:${key}`;
	}

	private getStatePattern(namespace: string): string {
		return `bittery:rl:state:${namespace}:*`;
	}

	private getWindowKey(namespace: string, window: string, key: string): string {
		return `bittery:rl:window:${namespace}:${window}:${key}`;
	}
}
