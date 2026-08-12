import type {
	BillingEntitlements,
	BillingPlan,
	BillingStatus,
	TeamType,
} from "@bittery/api-contract";

/**
 * `BillingPlan`, `BillingStatus` and `TeamType` are closed sets owned by
 * `apps/server/src/db/enums.rs` and generated into the contract. This module aliases them
 * rather than restating them (ADR 0012); `CloudPlanId` is the local name the pricing
 * tables below have always used for a billing plan.
 */
export type { BillingStatus };
export type CloudPlanId = BillingPlan;

export type BillingMode = "cloud" | "self-hosted";

/**
 * Every plan, in display order. `satisfies` pins the members to the generated set and the
 * `Record<CloudPlanId, …>` tables below fail to compile if the server grows one.
 */
export const cloudPlanIds = [
	"free",
	"personal",
	"family",
	"team",
] as const satisfies readonly CloudPlanId[];

type AttachmentPlanLimits = Pick<
	EntitlementLimits,
	"attachmentMaxFileSizeBytes" | "attachmentStorageBytes"
>;

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
		attachmentMaxFileSizeBytes: 0,
		attachmentStorageBytes: 0,
	},
	personal: {
		attachmentMaxFileSizeBytes: 10 * MB,
		attachmentStorageBytes: 250 * MB,
	},
	family: {
		attachmentMaxFileSizeBytes: 25 * MB,
		attachmentStorageBytes: 1 * GB,
	},
	team: {
		attachmentMaxFileSizeBytes: 50 * MB,
		attachmentStorageBytes: 2 * GB,
	},
};

export function mapPlanToTeamType(plan: CloudPlanId): TeamType {
	if (plan === "family") return "family";
	if (plan === "team") return "organization";
	return "personal";
}

export function requiresPaidSubscription(plan: CloudPlanId): boolean {
	return plan !== "free";
}

/**
 * The entitlement names, keyed by the *wire's* spelling. Derived from the contract rather
 * than restated (ADR 0012) so a flag renamed server-side fails to compile here instead of
 * silently reading `undefined` — which, for a gate on a paid feature, is a wrong answer in
 * whichever direction the call site happens to default.
 */
export type EntitlementKey = keyof BillingEntitlements["entitlements"];
export type Entitlements = Record<EntitlementKey, boolean>;

/** Every entitlement, in display order. */
export const entitlementCatalog = [
	"sentinel",
	"teamManagement",
	"vaultSharing",
	"shareLinks",
	"billingPortal",
	"attachments",
] as const satisfies readonly EntitlementKey[];

/**
 * `satisfies` pins the catalogue to a subset of the wire's keys; this pins the other
 * direction, so a new server entitlement cannot be quietly left out of the list every
 * record below is built from. Errors as "Type 'x' does not satisfy the constraint 'never'",
 * naming the omitted key.
 */
type NoOmittedEntitlement<T extends never> = T;
const _catalogCoversTheWire = (
	omitted: NoOmittedEntitlement<
		Exclude<EntitlementKey, (typeof entitlementCatalog)[number]>
	>,
) => omitted;
void _catalogCoversTheWire;

interface ResolveEntitlementsInput {
	mode: BillingMode;
	billingPlan: CloudPlanId;
	billingStatus: BillingStatus;
}

/**
 * The numeric caps a plan carries, keyed by the *wire's* names. Mapped off the contract
 * rather than restated so a limit renamed server-side fails to compile in the tables
 * below; only the value type differs — the wire sends a decimal string the client parses
 * to `bigint`, while these are the plan catalogue's own plain numbers.
 */
export type EntitlementLimits = {
	[K in keyof BillingEntitlements["limits"]]-?: number | null;
};

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
	personal: ["sentinel", "shareLinks", "billingPortal", "attachments"],
	family: [
		"sentinel",
		"teamManagement",
		"vaultSharing",
		"shareLinks",
		"billingPortal",
		"attachments",
	],
	team: [
		"sentinel",
		"teamManagement",
		"vaultSharing",
		"shareLinks",
		"billingPortal",
		"attachments",
	],
};

export const planEntitlementLimits: Record<CloudPlanId, EntitlementLimits> = {
	free: {
		shareLinks: 0,
		sharedVaults: 0,
		...planAttachmentLimits.free,
	},
	personal: {
		shareLinks: 5,
		sharedVaults: 0,
		...planAttachmentLimits.personal,
	},
	family: {
		shareLinks: null,
		sharedVaults: 5,
		...planAttachmentLimits.family,
	},
	team: {
		shareLinks: null,
		sharedVaults: null,
		...planAttachmentLimits.team,
	},
};

const selfHostedEntitlements = new Set<EntitlementKey>([
	"sentinel",
	"teamManagement",
	"vaultSharing",
	"shareLinks",
	"attachments",
]);
const selfHostedEntitlementLimits: EntitlementLimits = {
	shareLinks: null,
	sharedVaults: null,
	attachmentMaxFileSizeBytes: null,
	attachmentStorageBytes: null,
};

const paidStatusGatedEntitlements = new Set<EntitlementKey>([
	"sentinel",
	"teamManagement",
	"vaultSharing",
	"shareLinks",
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

	if (!effectiveEntitlements.shareLinks) {
		limits.shareLinks = 0;
	}
	if (!effectiveEntitlements.vaultSharing) {
		limits.sharedVaults = 0;
	}
	if (!effectiveEntitlements.attachments) {
		limits.attachmentMaxFileSizeBytes = 0;
		limits.attachmentStorageBytes = 0;
	}

	return limits;
}

export function hasEntitlements(
	entitlements: Entitlements,
	required: readonly EntitlementKey[],
): boolean {
	return required.every((entitlement) => entitlements[entitlement]);
}
