import {
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * Unified rate-limit state table.
 * Supports:
 * - login/recovery exponential lockouts (attempts + lockedUntil)
 * - share-link daily creation limits (count + windowStartAt)
 */
export const rateLimitState = pgTable(
	"rate_limit_state",
	{
		scope: text("scope").notNull(),
		key: text("key").notNull(),
		subject: text("subject"),
		attempts: integer("attempts").default(0).notNull(),
		count: integer("count").default(0).notNull(),
		lastAttemptAt: timestamp("last_attempt_at"),
		lockedUntil: timestamp("locked_until"),
		windowStartAt: timestamp("window_start_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		primaryKey({
			columns: [table.scope, table.key],
			name: "rate_limit_state_scope_key_pk",
		}),
		index("rate_limit_state_subject_idx").on(table.scope, table.subject),
		index("rate_limit_state_locked_until_idx").on(table.lockedUntil),
		index("rate_limit_state_window_start_at_idx").on(table.windowStartAt),
	],
);
