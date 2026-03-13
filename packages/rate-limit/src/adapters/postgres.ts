import { db, rateLimitState } from "@bittery/db";
import { and, eq, or, sql } from "drizzle-orm";
import type {
	FailureBackoffInput,
	RateLimitAdapter,
	RateLimitState,
	WindowIncrementInput,
	WindowIncrementResult,
} from "../types";

export class PostgresRateLimitAdapter implements RateLimitAdapter {
	async get(namespace: string, key: string): Promise<RateLimitState | null> {
		const existing = await db.query.rateLimitState.findFirst({
			where: (record, { and: andFn, eq: eqFn }) =>
				andFn(eqFn(record.scope, namespace), eqFn(record.key, key)),
		});

		if (!existing) {
			return null;
		}

		return {
			namespace: existing.scope,
			key: existing.key,
			subject: existing.subject,
			attempts: existing.attempts,
			count: existing.count,
			lockedUntil: existing.lockedUntil,
			windowStartAt: existing.windowStartAt,
		};
	}

	async recordFailure(input: FailureBackoffInput): Promise<RateLimitState> {
		const existing = await this.get(input.namespace, input.key);
		const attempts = (existing?.attempts ?? 0) + 1;

		let lockedUntil: Date | null = null;
		if (attempts >= input.freeAttempts) {
			const lockMinutes = Math.min(
				input.maxLockMinutes,
				2 ** (attempts - input.freeAttempts),
			);
			lockedUntil = new Date(input.now.getTime() + lockMinutes * 60 * 1000);
		}

		await db
			.insert(rateLimitState)
			.values({
				scope: input.namespace,
				key: input.key,
				subject: input.subject,
				attempts,
				lastAttemptAt: input.now,
				lockedUntil,
				updatedAt: input.now,
			})
			.onConflictDoUpdate({
				target: [rateLimitState.scope, rateLimitState.key],
				set: {
					subject: input.subject,
					attempts,
					lastAttemptAt: input.now,
					lockedUntil,
					updatedAt: input.now,
				},
			});

		return {
			namespace: input.namespace,
			key: input.key,
			subject: input.subject,
			attempts,
			count: existing?.count ?? 0,
			lockedUntil,
			windowStartAt: existing?.windowStartAt ?? null,
		};
	}

	async clear(namespace: string, key: string): Promise<void> {
		await db
			.delete(rateLimitState)
			.where(
				and(eq(rateLimitState.scope, namespace), eq(rateLimitState.key, key)),
			);
	}

	async clearBySubject(namespace: string, subject: string): Promise<void> {
		await db
			.delete(rateLimitState)
			.where(
				and(
					eq(rateLimitState.scope, namespace),
					eq(rateLimitState.subject, subject),
				),
			);
	}

	async incrementWithinWindow(
		input: WindowIncrementInput,
	): Promise<WindowIncrementResult> {
		await db
			.insert(rateLimitState)
			.values({
				scope: input.namespace,
				key: input.key,
				subject: input.subject ?? input.key,
				count: 0,
				windowStartAt: input.windowStart,
				updatedAt: input.now,
			})
			.onConflictDoNothing();

		const result = await db
			.update(rateLimitState)
			.set({
				count: sql`CASE
					WHEN ${rateLimitState.windowStartAt} < ${input.windowStart}
					THEN 1
					ELSE ${rateLimitState.count} + 1
				END`,
				windowStartAt: sql`CASE
					WHEN ${rateLimitState.windowStartAt} < ${input.windowStart}
					THEN ${input.windowStart}
					ELSE ${rateLimitState.windowStartAt}
				END`,
				updatedAt: input.now,
			})
			.where(
				and(
					eq(rateLimitState.scope, input.namespace),
					eq(rateLimitState.key, input.key),
					or(
						sql`${rateLimitState.windowStartAt} < ${input.windowStart}`,
						sql`${rateLimitState.count} < ${input.limit}`,
					),
				),
			)
			.returning({ count: rateLimitState.count });

		if (result.length === 0) {
			return {
				allowed: false,
				count: input.limit,
				limit: input.limit,
			};
		}

		return {
			allowed: true,
			count: result[0]?.count ?? 0,
			limit: input.limit,
		};
	}

	async close(): Promise<void> {}
}
