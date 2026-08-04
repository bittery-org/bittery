/**
 * Plan entitlements for the E2E stack, written straight into its database.
 *
 * WHY THIS EXISTS - please do not "clean this up":
 *
 * Shared vaults, team membership and share links are all server-side
 * entitlements. Converting a personal vault to a shared one needs
 * `resolve_vault_sharing_entitlement` to pass (`apps/server/src/services/vault.rs`),
 * inviting anyone needs `assert_team_management_entitlement`
 * (`apps/server/src/services/team.rs`), and creating a share link needs
 * `resolve_share_links_policy` (`apps/server/src/services/team_billing.rs`);
 * all three demand a Family or Team plan whose billing status is active or
 * trialing. In production a Stripe webhook writes those columns
 * (`apps/server/src/services/billing/webhook.rs`). The E2E stack deliberately
 * runs without Stripe credentials, so a signup lands on the Free plan with
 * `billing_status = 'none'` and every one of those paths 403s.
 *
 * Rather than leave that half of the product untested, a spec that needs a
 * shared vault provisions the same three columns the webhook would. This is a
 * fixture, not a product code path: no server code changes, nothing here ships,
 * and the entitlement checks themselves stay fully enforced.
 */
import { type CloudPlanId, planMemberLimits } from "@bittery/shared/billing";
import { runE2eSql, sqlString } from "./e2e-database";

/**
 * Put the team behind one account on an active cloud plan.
 *
 * The member limit comes from `planMemberLimits` rather than a literal, so a
 * fixture-provisioned plan is seat-limited exactly the way a Stripe-provisioned
 * one is.
 */
export function activateCloudPlan(
	email: string,
	plan: CloudPlanId,
	database = "bittery_e2e",
): void {
	const memberLimit = planMemberLimits[plan];
	// Signup lowercases the address before storing it, so a generated mixed-case
	// email only matches case-insensitively.
	const result = runE2eSql(
		`UPDATE team SET billing_plan = '${plan}', billing_status = 'active', member_limit = ${memberLimit === null ? "NULL" : memberLimit} WHERE id = (SELECT team_id FROM "user" WHERE lower(email) = lower('${sqlString(email)}'))`,
		database,
	);

	// psql reports the row count, which is the only way to notice that the email
	// never matched an account and the spec is about to test nothing.
	if (result !== "UPDATE 1") {
		throw new Error(
			`Expected exactly one team row for ${email}, psql said: ${result}`,
		);
	}
}

/**
 * Put the team behind one account on an active Team plan.
 *
 * Team is the only plan with no member limit, so it also unlocks the second
 * vault member a "make private is blocked" test needs, and the only plan with
 * no cap on active share links.
 */
export function activateTeamPlan(
	email: string,
	database = "bittery_e2e",
): void {
	activateCloudPlan(email, "team", database);
}
