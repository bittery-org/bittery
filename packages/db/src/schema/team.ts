import { relations } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { vault } from "./vault";

// Team member roles
export const teamRoleEnum = pgEnum("team_role", ["owner", "admin", "member"]);

// Invitation status
export const invitationStatusEnum = pgEnum("invitation_status", [
	"pending",
	"accepted",
	"declined",
	"expired",
]);

export const team = pgTable("team", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	ownerId: text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

export const teamMember = pgTable(
	"team_member",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => team.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: teamRoleEnum("role").notNull().default("member"),
		invitedAt: timestamp("invited_at").defaultNow().notNull(),
		joinedAt: timestamp("joined_at"),
	},
	(table) => [
		index("team_member_teamId_idx").on(table.teamId),
		index("team_member_userId_idx").on(table.userId),
	],
);

// Pending invitations for users who haven't signed up yet
export const teamInvitation = pgTable(
	"team_invitation",
	{
		id: text("id").primaryKey(),
		teamId: text("team_id")
			.notNull()
			.references(() => team.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: teamRoleEnum("role").notNull().default("member"),
		invitedById: text("invited_by_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		status: invitationStatusEnum("status").notNull().default("pending"),
		token: text("token").notNull().unique(), // Unique invitation token
		// Encrypted vault keys for team vaults - attached when user accepts
		pendingVaultKeys: text("pending_vault_keys"), // JSON array of encrypted keys
		expiresAt: timestamp("expires_at").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		acceptedAt: timestamp("accepted_at"),
	},
	(table) => [
		index("team_invitation_teamId_idx").on(table.teamId),
		index("team_invitation_email_idx").on(table.email),
		index("team_invitation_token_idx").on(table.token),
	],
);

// Relations
export const teamRelations = relations(team, ({ one, many }) => ({
	owner: one(user, {
		fields: [team.ownerId],
		references: [user.id],
	}),
	members: many(teamMember),
	invitations: many(teamInvitation),
	vaults: many(vault),
}));

export const teamMemberRelations = relations(teamMember, ({ one }) => ({
	team: one(team, {
		fields: [teamMember.teamId],
		references: [team.id],
	}),
	user: one(user, {
		fields: [teamMember.userId],
		references: [user.id],
	}),
}));

export const teamInvitationRelations = relations(teamInvitation, ({ one }) => ({
	team: one(team, {
		fields: [teamInvitation.teamId],
		references: [team.id],
	}),
	invitedBy: one(user, {
		fields: [teamInvitation.invitedById],
		references: [user.id],
	}),
}));
