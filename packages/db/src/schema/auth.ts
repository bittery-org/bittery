import { relations } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	// Zero-knowledge authentication fields
	secretKeyHint: text("secret_key_hint"), // First segment of Secret Key (A3-XXXXXX)
	srpSalt: text("srp_salt").notNull(),
	srpVerifier: text("srp_verifier").notNull(),
	// RSA keys for vault sharing
	publicKey: text("public_key").notNull(), // RSA public key (PEM)
	encryptedPrivateKey: text("encrypted_private_key").notNull(), // RSA private key encrypted with Master Unlock Key
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const session = pgTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at").notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		// Device information
		deviceName: text("device_name"), // User-editable name or auto-generated (e.g., "Chrome on macOS")
		platform: text("platform"), // "web" | "desktop" | "extension" | "ios" | "android"
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

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}));
