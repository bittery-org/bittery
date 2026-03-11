import { relations } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
	billingPlanEnum,
	billingStatusEnum,
	invitationStatusEnum,
	teamRoleEnum,
	teamTypeEnum,
} from "./enums";
import { vault } from "./vault";

export const team = pgTable("team", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	ownerId: text("owner_id")
		.notNull()
		.references((): AnyPgColumn => user.id, { onDelete: "cascade" }),
	type: teamTypeEnum("type").default("personal").notNull(),
	memberLimit: integer("member_limit"), // NULL = unlimited
	billingPlan: billingPlanEnum("billing_plan").default("free").notNull(),
	billingStatus: billingStatusEnum("billing_status").default("none").notNull(),
	stripeCustomerId: text("stripe_customer_id").unique(),
	stripeSubscriptionId: text("stripe_subscription_id").unique(),
	stripeSubscriptionItemId: text("stripe_subscription_item_id"),
	stripePriceId: text("stripe_price_id"),
	seatsPurchased: integer("seats_purchased"),
	currentPeriodEnd: timestamp("current_period_end"),
	cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
	imageKey: text("image_key"), // S3 key for team avatar
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at")
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
});

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
	users: many(user), // One-to-many: team has many users
	invitations: many(teamInvitation),
	vaults: many(vault),
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
