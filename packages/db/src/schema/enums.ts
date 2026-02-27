import { pgEnum } from "drizzle-orm/pg-core";

// Team member roles
export const teamRoleEnum = pgEnum("team_role", ["owner", "admin", "member"]);

// Team types
export const teamTypeEnum = pgEnum("team_type", [
	"personal",
	"family",
	"organization",
]);

// Invitation status
export const invitationStatusEnum = pgEnum("invitation_status", [
	"pending",
	"accepted",
	"declined",
	"expired",
]);

// Billing plans
export const billingPlanEnum = pgEnum("billing_plan", [
	"free",
	"personal",
	"family",
	"team",
]);

// Billing status derived from Stripe subscription state
export const billingStatusEnum = pgEnum("billing_status", [
	"none",
	"incomplete",
	"trialing",
	"active",
	"past_due",
	"canceled",
	"unpaid",
]);
