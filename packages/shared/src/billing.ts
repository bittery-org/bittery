import type { BillingEntitlements, BillingPlan } from "@bittery/api-contract";

/**
 * `BillingPlan` is a closed set owned by `apps/server/src/db/enums.rs` and generated into
 * the contract. This module aliases it rather than restating it (ADR 0012); `CloudPlanId` is
 * the local name the pricing tables below have always used for a billing plan.
 */
export type CloudPlanId = BillingPlan;

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

/**
 * The entitlement names, keyed by the *wire's* spelling. Derived from the contract rather
 * than restated (ADR 0012) so a flag renamed server-side fails to compile here instead of
 * silently reading `undefined` — which, for a gate on a paid feature, is a wrong answer in
 * whichever direction the call site happens to default.
 */
export type EntitlementKey = keyof BillingEntitlements["entitlements"];
export type Entitlements = Record<EntitlementKey, boolean>;

/**
 * The numeric caps a plan carries, keyed by the *wire's* names. Mapped off the contract
 * rather than restated so a limit renamed server-side fails to compile in the tables
 * below; only the value type differs — the wire sends a decimal string the client parses
 * to `bigint`, while these are the plan catalogue's own plain numbers.
 */
export type EntitlementLimits = {
	[K in keyof BillingEntitlements["limits"]]-?: number | null;
};
