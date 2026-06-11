export type BillingMode = "cloud" | "self-hosted";

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

export type BillingStatus =
	| "none"
	| "incomplete"
	| "trialing"
	| "active"
	| "past_due"
	| "canceled"
	| "unpaid";

export interface TeamBillingState {
	id: string;
	billingPlan: CloudPlanId;
	billingStatus: BillingStatus;
}

export const entitlementCatalog = [
	"sentinel",
	"team_management",
	"vault_sharing",
	"share_links",
	"billing_portal",
	"attachments",
] as const;

export type EntitlementKey = (typeof entitlementCatalog)[number];
export type Entitlements = Record<EntitlementKey, boolean>;

export interface ResolveEntitlementsInput {
	mode: BillingMode;
	billingPlan: CloudPlanId;
	billingStatus: BillingStatus;
}

export interface EntitlementLimits {
	share_links: number | null;
	shared_vaults: number | null;
	attachment_max_file_size_bytes: number | null;
	attachment_storage_bytes: number | null;
}

const activeStatuses = new Set<BillingStatus>(["active", "trialing"]);

export function isBillingActive(
	status: BillingStatus | null | undefined,
): boolean {
	if (!status) {
		return false;
	}
	return activeStatuses.has(status);
}

export const planEntitlementMap: Record<
	CloudPlanId,
	readonly EntitlementKey[]
> = {
	free: [],
	personal: ["sentinel", "share_links", "billing_portal", "attachments"],
	family: [
		"sentinel",
		"team_management",
		"vault_sharing",
		"share_links",
		"billing_portal",
		"attachments",
	],
	team: [
		"sentinel",
		"team_management",
		"vault_sharing",
		"share_links",
		"billing_portal",
		"attachments",
	],
};

export const planEntitlementLimits: Record<CloudPlanId, EntitlementLimits> = {
	free: {
		share_links: 0,
		shared_vaults: 0,
		...planAttachmentLimits.free,
	},
	personal: {
		share_links: 5,
		shared_vaults: 0,
		...planAttachmentLimits.personal,
	},
	family: {
		share_links: null,
		shared_vaults: 5,
		...planAttachmentLimits.family,
	},
	team: {
		share_links: null,
		shared_vaults: null,
		...planAttachmentLimits.team,
	},
};

const selfHostedEntitlements = new Set<EntitlementKey>([
	"sentinel",
	"team_management",
	"vault_sharing",
	"share_links",
	"attachments",
]);
const selfHostedEntitlementLimits: EntitlementLimits = {
	share_links: null,
	shared_vaults: null,
	attachment_max_file_size_bytes: null,
	attachment_storage_bytes: null,
};

const paidStatusGatedEntitlements = new Set<EntitlementKey>([
	"sentinel",
	"team_management",
	"vault_sharing",
	"share_links",
	"attachments",
]);

function buildEntitlementRecord(
	enabledEntitlements: ReadonlySet<EntitlementKey>,
): Entitlements {
	const entitlements = {} as Entitlements;
	for (const entitlement of entitlementCatalog) {
		entitlements[entitlement] = enabledEntitlements.has(entitlement);
	}
	return entitlements;
}

export function resolveEffectiveEntitlements(
	input: ResolveEntitlementsInput,
): Entitlements {
	if (input.mode === "self-hosted") {
		return buildEntitlementRecord(selfHostedEntitlements);
	}

	const enabledEntitlements = new Set<EntitlementKey>(
		planEntitlementMap[input.billingPlan],
	);

	if (
		requiresPaidSubscription(input.billingPlan) &&
		!isBillingActive(input.billingStatus)
	) {
		for (const entitlement of paidStatusGatedEntitlements) {
			enabledEntitlements.delete(entitlement);
		}
	}

	return buildEntitlementRecord(enabledEntitlements);
}

export function resolveEffectiveEntitlementLimits(
	input: ResolveEntitlementsInput,
	entitlements?: Entitlements,
): EntitlementLimits {
	if (input.mode === "self-hosted") {
		return selfHostedEntitlementLimits;
	}

	const effectiveEntitlements =
		entitlements || resolveEffectiveEntitlements(input);
	const limits = { ...planEntitlementLimits[input.billingPlan] };

	if (!effectiveEntitlements.share_links) {
		limits.share_links = 0;
	}
	if (!effectiveEntitlements.vault_sharing) {
		limits.shared_vaults = 0;
	}
	if (!effectiveEntitlements.attachments) {
		limits.attachment_max_file_size_bytes = 0;
		limits.attachment_storage_bytes = 0;
	}

	return limits;
}

export function hasEntitlements(
	entitlements: Entitlements,
	required: readonly EntitlementKey[],
): boolean {
	return required.every((entitlement) => entitlements[entitlement]);
}
