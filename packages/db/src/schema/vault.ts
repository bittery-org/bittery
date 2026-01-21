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

// Vault types: personal (owned by user) or team (shared)
export const vaultTypeEnum = pgEnum("vault_type", ["personal", "team"]);

// Vault access roles
export const vaultRoleEnum = pgEnum("vault_role", [
	"owner",
	"admin",
	"member",
	"read-only",
]);

// Item categories
export const itemCategoryEnum = pgEnum("item_category", [
	"login",
	"secure-note",
	"credit-card",
	"identity",
	"totp",
]);

export const vault = pgTable("vault", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	type: vaultTypeEnum("type").notNull().default("personal"),
	icon: text("icon"),
	imageKey: text("image_key"),
	createdById: text("created_by_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	teamId: text("team_id"), // null for personal vaults
	// Current key version (increments with each rotation)
	keyVersion: integer("key_version").notNull().default(1),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

// Stores encrypted vault keys for each user with access
export const vaultKey = pgTable(
	"vault_key",
	{
		id: text("id").primaryKey(),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// Encrypted vault encryption key
		// For personal vaults: encrypted with user's Master Unlock Key
		// For team vaults: encrypted with user's RSA public key
		encryptedVaultKey: text("encrypted_vault_key").notNull(),
		role: vaultRoleEnum("role").notNull().default("member"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("vault_key_vaultId_idx").on(table.vaultId),
		index("vault_key_userId_idx").on(table.userId),
	],
);

// Password items stored in vaults
export const item = pgTable(
	"item",
	{
		id: text("id").primaryKey(),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		category: itemCategoryEnum("category").notNull().default("login"),
		favorite: boolean("favorite").notNull().default(false),
		// Encrypted sensitive data (includes title, url, username, password, notes, customFields, etc.)
		encryptedData: text("encrypted_data").notNull(),
		// IV and algorithm info
		encryptionIv: text("encryption_iv").notNull(),
		encryptionAlgorithm: text("encryption_algorithm")
			.notNull()
			.default("AES-GCM"),
		// Version for conflict detection (increments on each update)
		version: integer("version").notNull().default(1),
		// User who last modified this item
		lastModifiedBy: text("last_modified_by").references(() => user.id),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
		deletedAt: timestamp("deleted_at"), // Soft delete for trash
	},
	(table) => [
		index("item_vaultId_idx").on(table.vaultId),
		index("item_deletedAt_idx").on(table.deletedAt),
	],
);

// Folders for organizing items
export const folder = pgTable(
	"folder",
	{
		id: text("id").primaryKey(),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		parentId: text("parent_id"), // For nested folders
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("folder_vaultId_idx").on(table.vaultId)],
);

// Key rotation reason enum
export const keyRotationReasonEnum = pgEnum("key_rotation_reason", [
	"member_removed",
	"scheduled",
	"security_breach",
	"manual",
]);

// Tracks vault key rotations for audit and history
export const vaultKeyRotation = pgTable(
	"vault_key_rotation",
	{
		id: text("id").primaryKey(),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		// Key version number (increments with each rotation)
		keyVersion: integer("key_version").notNull().default(1),
		// The reason for rotation
		reason: keyRotationReasonEnum("reason").notNull(),
		// User who initiated the rotation
		initiatedById: text("initiated_by_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		// If rotation was due to member removal, store the removed user's ID
		removedUserId: text("removed_user_id"),
		// Number of items re-encrypted during this rotation
		itemsReEncrypted: integer("items_re_encrypted").notNull().default(0),
		// Number of members whose keys were updated
		membersUpdated: integer("members_updated").notNull().default(0),
		// Status of the rotation
		status: text("status").notNull().default("completed"), // "in_progress", "completed", "failed"
		// Error message if rotation failed
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		completedAt: timestamp("completed_at"),
	},
	(table) => [
		index("vault_key_rotation_vaultId_idx").on(table.vaultId),
		index("vault_key_rotation_initiatedById_idx").on(table.initiatedById),
	],
);

// Relations
export const vaultRelations = relations(vault, ({ one, many }) => ({
	createdBy: one(user, {
		fields: [vault.createdById],
		references: [user.id],
	}),
	vaultKeys: many(vaultKey),
	items: many(item),
	folders: many(folder),
	keyRotations: many(vaultKeyRotation),
}));

export const vaultKeyRelations = relations(vaultKey, ({ one }) => ({
	vault: one(vault, {
		fields: [vaultKey.vaultId],
		references: [vault.id],
	}),
	user: one(user, {
		fields: [vaultKey.userId],
		references: [user.id],
	}),
}));

export const itemRelations = relations(item, ({ one }) => ({
	vault: one(vault, {
		fields: [item.vaultId],
		references: [vault.id],
	}),
}));

export const folderRelations = relations(folder, ({ one }) => ({
	vault: one(vault, {
		fields: [folder.vaultId],
		references: [vault.id],
	}),
	parent: one(folder, {
		fields: [folder.parentId],
		references: [folder.id],
	}),
}));

export const vaultKeyRotationRelations = relations(
	vaultKeyRotation,
	({ one }) => ({
		vault: one(vault, {
			fields: [vaultKeyRotation.vaultId],
			references: [vault.id],
		}),
		initiatedBy: one(user, {
			fields: [vaultKeyRotation.initiatedById],
			references: [user.id],
		}),
	}),
);
