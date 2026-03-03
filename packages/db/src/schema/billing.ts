import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const stripeEventLog = pgTable(
	"stripe_event_log",
	{
		id: text("id").primaryKey(),
		eventId: text("event_id").notNull().unique(),
		eventType: text("event_type").notNull(),
		payloadHash: text("payload_hash"),
		processedAt: timestamp("processed_at").defaultNow().notNull(),
	},
	(table) => [
		index("stripe_event_log_event_id_idx").on(table.eventId),
		index("stripe_event_log_processed_at_idx").on(table.processedAt),
	],
);
