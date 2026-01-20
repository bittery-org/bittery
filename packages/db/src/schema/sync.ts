import { relations } from "drizzle-orm";
import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { vault } from "./vault";

// Sync event types
export const syncEventTypeEnum = pgEnum("sync_event_type", [
	"item_created",
	"item_updated",
	"item_deleted",
	"item_restored",
	"vault_created",
	"vault_updated",
	"vault_deleted",
	"vault_member_added",
	"vault_member_removed",
	"vault_key_rotated",
]);

// Entity types that can be synced
export const syncEntityTypeEnum = pgEnum("sync_entity_type", [
	"item",
	"vault",
	"vault_member",
	"vault_key",
]);

// Tracks sync events for change propagation
export const syncEvent = pgTable(
	"sync_event",
	{
		id: text("id").primaryKey(),
		eventType: syncEventTypeEnum("event_type").notNull(),
		vaultId: text("vault_id").references(() => vault.id, {
			onDelete: "cascade",
		}),
		entityId: text("entity_id").notNull(),
		entityType: syncEntityTypeEnum("entity_type").notNull(),
		// Client ID for optimistic update correlation (to ignore own events)
		clientId: text("client_id"),
		// Version number for conflict detection
		version: integer("version").notNull().default(1),
		// User who triggered the event
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Event metadata (JSON stringified)
		metadata: text("metadata"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("sync_event_vaultId_idx").on(table.vaultId),
		index("sync_event_userId_idx").on(table.userId),
		index("sync_event_createdAt_idx").on(table.createdAt),
		index("sync_event_entityId_idx").on(table.entityId),
	],
);

// Tracks which events have been acknowledged by each client
export const syncEventAck = pgTable(
	"sync_event_ack",
	{
		id: text("id").primaryKey(),
		eventId: text("event_id")
			.notNull()
			.references(() => syncEvent.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		clientId: text("client_id").notNull(),
		acknowledgedAt: timestamp("acknowledged_at").defaultNow().notNull(),
	},
	(table) => [
		index("sync_event_ack_eventId_idx").on(table.eventId),
		index("sync_event_ack_userId_idx").on(table.userId),
	],
);

// Relations
export const syncEventRelations = relations(syncEvent, ({ one, many }) => ({
	vault: one(vault, {
		fields: [syncEvent.vaultId],
		references: [vault.id],
	}),
	user: one(user, {
		fields: [syncEvent.userId],
		references: [user.id],
	}),
	acknowledgements: many(syncEventAck),
}));

export const syncEventAckRelations = relations(syncEventAck, ({ one }) => ({
	event: one(syncEvent, {
		fields: [syncEventAck.eventId],
		references: [syncEvent.id],
	}),
	user: one(user, {
		fields: [syncEventAck.userId],
		references: [user.id],
	}),
}));
