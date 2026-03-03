/**
 * Team helpers
 * Shared logic for team operations across routers.
 */

import { db, team, user } from "@bittery/db";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

/** Drizzle transaction type */
type Transaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/**
 * Create a personal team with a free plan for a user.
 *
 * Used when a user is removed from a family/team plan — they need their own
 * personal team so they aren't left in an orphaned state with `teamId = null`.
 *
 * The user already has a personal vault from signup, so we only need to create
 * the team row and link the user to it.
 */
export async function createPersonalTeamForUser(
	userId: string,
	userName: string,
	tx?: Transaction,
): Promise<string> {
	const executor = tx ?? db;

	const teamId = nanoid();
	await executor.insert(team).values({
		id: teamId,
		name: `${userName}'s Team`,
		ownerId: userId,
		type: "personal",
		memberLimit: 1,
		billingPlan: "free",
		billingStatus: "none",
	});

	await executor
		.update(user)
		.set({ teamId, role: "owner" })
		.where(eq(user.id, userId));

	return teamId;
}
