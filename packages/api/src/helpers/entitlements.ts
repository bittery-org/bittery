import { db } from "@bittery/db";
import { resolveEffectiveEntitlements } from "../billing/entitlements";
import { getBitteryMode } from "../config/mode";

export async function canUserUseAttachments(userId: string): Promise<boolean> {
	const actor = await db.query.user.findFirst({
		where: (user, { eq: eqFn }) => eqFn(user.id, userId),
		with: { team: true },
	});
	const mode = getBitteryMode();

	// In cloud mode, fail closed for orphaned users with no team linkage.
	if (!actor?.team) {
		return mode === "self-hosted";
	}

	return resolveEffectiveEntitlements({
		mode,
		billingPlan: actor.team.billingPlan,
		billingStatus: actor.team.billingStatus,
	}).attachments;
}
