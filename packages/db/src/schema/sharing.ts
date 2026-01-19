import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { item } from "./vault";

// Share link status
export const shareLinkStatusEnum = pgEnum("share_link_status", [
	"active",
	"expired",
	"exhausted",
	"revoked",
]);

// Share link access mode
export const shareLinkAccessModeEnum = pgEnum("share_link_access_mode", [
	"anyone",
	"email-restricted",
]);

// Expiration options (in hours)
export const EXPIRATION_OPTIONS = {
	"1hour": 1,
	"1day": 24,
	"7days": 168,
	"14days": 336,
	"30days": 720,
} as const;

export type ExpirationOption = keyof typeof EXPIRATION_OPTIONS;

// Share link - stores metadata for shared vault items
export const shareLink = pgTable(
	"share_link",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		createdById: text("created_by_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Unique token for the shareable link
		token: text("token").notNull().unique(),
		// Link configuration
		status: shareLinkStatusEnum("status").notNull().default("active"),
		accessMode: shareLinkAccessModeEnum("access_mode")
			.notNull()
			.default("anyone"),
		isOneTimeUse: boolean("is_one_time_use").notNull().default(false),
		// Encrypted item data snapshot for sharing (encrypted with share-specific key)
		encryptedItemData: text("encrypted_item_data").notNull(),
		encryptionIv: text("encryption_iv").notNull(),
		// The share key encrypted with a passphrase or directly accessible
		encryptedShareKey: text("encrypted_share_key").notNull(),
		shareKeyIv: text("share_key_iv").notNull(),
		// Access tracking
		accessCount: integer("access_count").notNull().default(0),
		maxAccessCount: integer("max_access_count"), // null means unlimited
		// Timestamps
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		lastAccessedAt: timestamp("last_accessed_at"),
	},
	(table) => [
		index("share_link_itemId_idx").on(table.itemId),
		index("share_link_createdById_idx").on(table.createdById),
		index("share_link_token_idx").on(table.token),
		index("share_link_status_idx").on(table.status),
	],
);

// Allowed emails for email-restricted share links
export const shareLinkAllowedEmail = pgTable(
	"share_link_allowed_email",
	{
		id: text("id").primaryKey(),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => shareLink.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		verified: boolean("verified").notNull().default(false),
		verifiedAt: timestamp("verified_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("share_link_allowed_email_shareLinkId_idx").on(table.shareLinkId),
		index("share_link_allowed_email_email_idx").on(table.email),
	],
);

// Email verification codes for restricted share links
export const shareEmailVerification = pgTable(
	"share_email_verification",
	{
		id: text("id").primaryKey(),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => shareLink.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		code: text("code").notNull(), // 6-digit code
		attempts: integer("attempts").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(5),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		usedAt: timestamp("used_at"),
	},
	(table) => [
		index("share_email_verification_shareLinkId_idx").on(table.shareLinkId),
		index("share_email_verification_email_idx").on(table.email),
		index("share_email_verification_code_idx").on(table.code),
	],
);

// Access logs for share links
export const shareAccessLog = pgTable(
	"share_access_log",
	{
		id: text("id").primaryKey(),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => shareLink.id, { onDelete: "cascade" }),
		// Access details
		accessedByEmail: text("accessed_by_email"), // null for "anyone" mode
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		// Access result
		success: boolean("success").notNull(),
		failureReason: text("failure_reason"),
		// Timestamps
		accessedAt: timestamp("accessed_at").defaultNow().notNull(),
	},
	(table) => [
		index("share_access_log_shareLinkId_idx").on(table.shareLinkId),
		index("share_access_log_accessedAt_idx").on(table.accessedAt),
	],
);

// Rate limiting for share link generation
export const shareLinkRateLimit = pgTable(
	"share_link_rate_limit",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		linksCreatedToday: integer("links_created_today").notNull().default(0),
		dailyLimit: integer("daily_limit").notNull().default(50),
		lastResetAt: timestamp("last_reset_at").defaultNow().notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [index("share_link_rate_limit_userId_idx").on(table.userId)],
);

// Relations
export const shareLinkRelations = relations(shareLink, ({ one, many }) => ({
	item: one(item, {
		fields: [shareLink.itemId],
		references: [item.id],
	}),
	createdBy: one(user, {
		fields: [shareLink.createdById],
		references: [user.id],
	}),
	allowedEmails: many(shareLinkAllowedEmail),
	verifications: many(shareEmailVerification),
	accessLogs: many(shareAccessLog),
}));

export const shareLinkAllowedEmailRelations = relations(
	shareLinkAllowedEmail,
	({ one }) => ({
		shareLink: one(shareLink, {
			fields: [shareLinkAllowedEmail.shareLinkId],
			references: [shareLink.id],
		}),
	}),
);

export const shareEmailVerificationRelations = relations(
	shareEmailVerification,
	({ one }) => ({
		shareLink: one(shareLink, {
			fields: [shareEmailVerification.shareLinkId],
			references: [shareLink.id],
		}),
	}),
);

export const shareAccessLogRelations = relations(shareAccessLog, ({ one }) => ({
	shareLink: one(shareLink, {
		fields: [shareAccessLog.shareLinkId],
		references: [shareLink.id],
	}),
}));

export const shareLinkRateLimitRelations = relations(
	shareLinkRateLimit,
	({ one }) => ({
		user: one(user, {
			fields: [shareLinkRateLimit.userId],
			references: [user.id],
		}),
	}),
);
