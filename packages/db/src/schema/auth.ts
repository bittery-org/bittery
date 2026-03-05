import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { teamRoleEnum } from "./enums";
import { team } from "./team";

export const user = pgTable(
	"user",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		emailVerified: boolean("email_verified").default(false).notNull(),
		// Zero-knowledge authentication fields
		secretKeyHint: text("secret_key_hint"), // First segment of Secret Key (A3-XXXXXX)
		encryptedMasterKey: text("encrypted_master_key"), // Encrypted PBKDF2 master key for recovery flow
		recoveryKeyHint: text("recovery_key_hint"), // First segment of Recovery Key (R1-XXXXXX)
		srpSalt: text("srp_salt").notNull(),
		srpVerifier: text("srp_verifier").notNull(),
		// RSA keys for vault sharing
		publicKey: text("public_key").notNull(), // RSA public key (PEM)
		encryptedPrivateKey: text("encrypted_private_key").notNull(), // RSA private key encrypted with Master Unlock Key
		// Team membership (one-to-one relationship)
		teamId: text("team_id"),
		role: teamRoleEnum("role").default("owner").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("user_team_id_idx").on(table.teamId)],
);

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		// Device information
		deviceName: text("device_name"), // User-editable name or auto-generated (e.g., "Chrome on macOS")
		platform: text("platform"), // "web" | "desktop" | "extension" | "ios" | "android"
		deviceInfo: text("device_info"), // User agent / device identifier payload for session management
		browserName: text("browser_name"), // "Chrome", "Safari", "Firefox", etc.
		browserVersion: text("browser_version"), // "120.0.0"
		osName: text("os_name"), // "macOS", "Windows", "Linux", "iOS", "Android"
		osVersion: text("os_version"), // "14.0", "11", etc.
		// Activity tracking
		lastActiveAt: timestamp("last_active_at").defaultNow().notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_userId_idx").on(table.userId)],
);

export const recoveryVerification = pgTable(
	"recovery_verification",
	{
		id: text("id").primaryKey(),
		email: text("email").notNull(),
		code: text("code").notNull(), // 6-digit code
		attempts: integer("attempts").default(0).notNull(),
		maxAttempts: integer("max_attempts").default(5).notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		usedAt: timestamp("used_at"),
	},
	(table) => [
		index("recovery_verification_email_idx").on(table.email),
		index("recovery_verification_code_idx").on(table.code),
		index("recovery_verification_expires_at_idx").on(table.expiresAt),
	],
);

export const auditLog = pgTable(
	"audit_log",
	{
		id: text("id").primaryKey(),
		// Kept as plain text (no FK) so logs can survive account deletion.
		userId: text("user_id").notNull(),
		action: text("action").notNull(),
		entityType: text("entity_type"),
		entityId: text("entity_id"),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		metadata: text("metadata"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("audit_log_userId_idx").on(table.userId),
		index("audit_log_action_idx").on(table.action),
		index("audit_log_createdAt_idx").on(table.createdAt),
	],
);

export const userRelations = relations(user, ({ one, many }) => ({
	sessions: many(session),
	auditLogs: many(auditLog),
	team: one(team, {
		fields: [user.teamId],
		references: [team.id],
	}),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
	user: one(user, {
		fields: [auditLog.userId],
		references: [user.id],
	}),
}));
