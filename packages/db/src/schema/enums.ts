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
