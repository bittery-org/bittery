import type { ItemCategory } from "@bittery/shared";
import type {
	CloudPlanId,
	EntitlementLimits,
	Entitlements,
} from "@bittery/shared/billing";

/**
 * What the two billing normalizers accept: the wire's own shapes, with every field
 * optional because a call site reads them off a query that may not have resolved. Both
 * key sets are derived from the contract, so neither can drift from what the server sends.
 */
type BillingEntitlementsLike = Partial<Entitlements>;

type BillingLimitsLike = Partial<
	Record<keyof EntitlementLimits, bigint | number | null>
>;

export function normalizeDeploymentMode(
	mode: string | null | undefined,
): "cloud" | "self-hosted" {
	return mode === "self-hosted" ? "self-hosted" : "cloud";
}

export function normalizeCloudPlanId(
	plan: string | null | undefined,
): CloudPlanId | undefined {
	switch (plan) {
		case "free":
		case "personal":
		case "family":
		case "team":
			return plan;
		default:
			return undefined;
	}
}

export function normalizeTeamRole(role: string): "owner" | "admin" | "member" {
	switch (role) {
		case "owner":
		case "admin":
		case "member":
			return role;
		default:
			return "member";
	}
}

export function normalizeItemCategory(category: string): ItemCategory {
	switch (category) {
		case "login":
		case "secure-note":
		case "credit-card":
		case "identity":
		case "totp":
			return category;
		default:
			return "secure-note";
	}
}

/**
 * Missing means denied: an entitlement absent from an unresolved query reads `false`, never
 * `undefined`. The `Entitlements` return type is the exhaustiveness check — a new wire
 * entitlement fails to compile here rather than defaulting to whatever a call site assumes.
 */
export function normalizeEntitlements(
	entitlements: BillingEntitlementsLike | null | undefined,
): Entitlements {
	return {
		sentinel: entitlements?.sentinel === true,
		teamManagement: entitlements?.teamManagement === true,
		vaultSharing: entitlements?.vaultSharing === true,
		shareLinks: entitlements?.shareLinks === true,
		billingPortal: entitlements?.billingPortal === true,
		attachments: entitlements?.attachments === true,
	};
}

function normalizeNullableNumber(
	value: bigint | number | null | undefined,
): number | null {
	return value == null ? null : Number(value);
}

export function normalizeEntitlementLimits(
	limits: BillingLimitsLike | null | undefined,
): EntitlementLimits {
	return {
		shareLinks: normalizeNullableNumber(limits?.shareLinks),
		sharedVaults: normalizeNullableNumber(limits?.sharedVaults),
		attachmentMaxFileSizeBytes: normalizeNullableNumber(
			limits?.attachmentMaxFileSizeBytes,
		),
		attachmentStorageBytes: normalizeNullableNumber(
			limits?.attachmentStorageBytes,
		),
	};
}
