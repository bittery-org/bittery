export const cloudPlanIds = ["free", "personal", "family", "team"] as const;
export type CloudPlanId = (typeof cloudPlanIds)[number];
export type TeamTypeForPlan = "personal" | "family" | "organization";

export const planMemberLimits: Record<CloudPlanId, number | null> = {
	free: 1,
	personal: 1,
	family: 6,
	team: null,
};

export function mapPlanToTeamType(plan: CloudPlanId): TeamTypeForPlan {
	if (plan === "family") return "family";
	if (plan === "team") return "organization";
	return "personal";
}

export function requiresPaidSubscription(plan: CloudPlanId): boolean {
	return plan !== "free";
}
