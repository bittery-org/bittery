import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
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
		// Overview: unencrypted metadata for fast listing/searching
		// { title: string, url?: string, username?: string }
		overview: jsonb("overview").notNull(),
		// Encrypted sensitive data
		// { password?: string, notes?: string, customFields?: object }
		encryptedData: text("encrypted_data").notNull(),
		// IV and algorithm info
		encryptionIv: text("encryption_iv").notNull(),
		encryptionAlgorithm: text("encryption_algorithm")
			.notNull()
			.default("AES-GCM"),
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

// Relations
export const vaultRelations = relations(vault, ({ one, many }) => ({
	createdBy: one(user, {
		fields: [vault.createdById],
		references: [user.id],
	}),
	vaultKeys: many(vaultKey),
	items: many(item),
	folders: many(folder),
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
