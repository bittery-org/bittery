import { TRPCError } from "@trpc/server";
import type { BitteryMode } from "../config/mode";
import type { CloudPlanId } from "./plans";
import { planAttachmentLimits, requiresPaidSubscription } from "./plans";

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
	mode: BitteryMode;
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

export function assertPaidPlanIsActive(team: TeamBillingState): void {
	if (!requiresPaidSubscription(team.billingPlan)) {
		return;
	}

	if (!isBillingActive(team.billingStatus)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"A paid subscription is required for this plan. Complete billing to continue.",
		});
	}
}

export function assertCollaborativePlan(team: TeamBillingState): void {
	if (!["family", "team"].includes(team.billingPlan)) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"This feature is only available on Family or Team plans. Upgrade to continue.",
		});
	}
}
