import {
	customType,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({
	dataType() {
		return "bytea";
	},
});

export const faviconStatusEnum = pgEnum("favicon_status", [
	"pending",
	"fetched",
	"failed",
]);

export const favicon = pgTable(
	"favicon",
	{
		domain: text("domain").primaryKey(),
		imageData: bytea("image_data"),
		contentType: text("content_type"),
		status: faviconStatusEnum("status").notNull().default("pending"),
		fetchedAt: timestamp("fetched_at"),
		failedAt: timestamp("failed_at"),
		failCount: integer("fail_count").notNull().default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		index("favicon_status_idx").on(table.status),
		index("favicon_fetched_at_idx").on(table.fetchedAt),
		index("favicon_failed_at_idx").on(table.failedAt),
	],
);
