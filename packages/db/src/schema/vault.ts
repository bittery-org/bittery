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
import { team } from "./team";

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
	teamId: text("team_id").references(() => team.id, {
		onDelete: "restrict",
	}), // null for personal vaults
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
			.default("AES-GCM-AAD-V1"),
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

// Encrypted file attachments for vault items
export const itemAttachment = pgTable(
	"item_attachment",
	{
		id: text("id").primaryKey(),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		// S3 object key for the encrypted file
		storageKey: text("storage_key").notNull(),
		// Encrypted metadata (filename + contentType encrypted with vault key)
		encryptedName: text("encrypted_name").notNull(),
		encryptedContentType: text("encrypted_content_type").notNull(),
		// IV used to encrypt the filename
		encryptionIv: text("encryption_iv").notNull(),
		// Separate IV for content-type (null on older rows → fall back to encryptionIv)
		encryptedContentTypeIv: text("encrypted_content_type_iv"),
		encryptionAlgorithm: text("encryption_algorithm")
			.notNull()
			.default("AES-GCM-AAD-V1"),
		// File size in bytes (not sensitive)
		fileSize: integer("file_size").notNull(),
		// Encrypted object size stored in object storage.
		storageSize: integer("storage_size").notNull().default(0),
		uploadedBy: text("uploaded_by").references(() => user.id),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("item_attachment_itemId_idx").on(table.itemId),
		index("item_attachment_vaultId_idx").on(table.vaultId),
	],
);

export const pendingAttachmentUpload = pgTable(
	"pending_attachment_upload",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => team.id, { onDelete: "cascade" }),
		vaultId: text("vault_id")
			.notNull()
			.references(() => vault.id, { onDelete: "cascade" }),
		itemId: text("item_id")
			.notNull()
			.references(() => item.id, { onDelete: "cascade" }),
		storageKey: text("storage_key").notNull().unique(),
		fileSize: integer("file_size").notNull(),
		storageSize: integer("storage_size").notNull(),
		contentType: text("content_type").notNull(),
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		expiresAt: timestamp("expires_at").notNull(),
		consumedAt: timestamp("consumed_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("pending_attachment_upload_teamId_idx").on(table.teamId),
		index("pending_attachment_upload_itemId_idx").on(table.itemId),
		index("pending_attachment_upload_createdBy_idx").on(table.createdBy),
		index("pending_attachment_upload_expiresAt_idx").on(table.expiresAt),
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

export const itemRelations = relations(item, ({ one, many }) => ({
	vault: one(vault, {
		fields: [item.vaultId],
		references: [vault.id],
	}),
	attachments: many(itemAttachment),
}));

export const itemAttachmentRelations = relations(itemAttachment, ({ one }) => ({
	item: one(item, {
		fields: [itemAttachment.itemId],
		references: [item.id],
	}),
	vault: one(vault, {
		fields: [itemAttachment.vaultId],
		references: [vault.id],
	}),
}));

export const pendingAttachmentUploadRelations = relations(
	pendingAttachmentUpload,
	({ one }) => ({
		team: one(team, {
			fields: [pendingAttachmentUpload.teamId],
			references: [team.id],
		}),
		vault: one(vault, {
			fields: [pendingAttachmentUpload.vaultId],
			references: [vault.id],
		}),
		item: one(item, {
			fields: [pendingAttachmentUpload.itemId],
			references: [item.id],
		}),
		user: one(user, {
			fields: [pendingAttachmentUpload.createdBy],
			references: [user.id],
		}),
	}),
);

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
