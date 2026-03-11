export const cloudPlanIds = ["free", "personal", "family", "team"] as const;
export type CloudPlanId = (typeof cloudPlanIds)[number];
export type TeamTypeForPlan = "personal" | "family" | "organization";

export interface AttachmentPlanLimits {
	attachment_max_file_size_bytes: number | null;
	attachment_storage_bytes: number | null;
}

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

export const planMemberLimits: Record<CloudPlanId, number | null> = {
	free: 1,
	personal: 1,
	family: 6,
	team: null,
};

export const planAttachmentLimits: Record<CloudPlanId, AttachmentPlanLimits> = {
	free: {
		attachment_max_file_size_bytes: 0,
		attachment_storage_bytes: 0,
	},
	personal: {
		attachment_max_file_size_bytes: 10 * MB,
		attachment_storage_bytes: 250 * MB,
	},
	family: {
		attachment_max_file_size_bytes: 25 * MB,
		attachment_storage_bytes: 1 * GB,
	},
	team: {
		attachment_max_file_size_bytes: 50 * MB,
		attachment_storage_bytes: 2 * GB,
	},
};

export function mapPlanToTeamType(plan: CloudPlanId): TeamTypeForPlan {
	if (plan === "family") return "family";
	if (plan === "team") return "organization";
	return "personal";
}

export function requiresPaidSubscription(plan: CloudPlanId): boolean {
	return plan !== "free";
}
