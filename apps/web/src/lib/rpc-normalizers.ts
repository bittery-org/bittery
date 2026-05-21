import type { ItemCategory } from "@bittery/shared";
import type { CloudPlanId, EntitlementKey } from "@bittery/shared/billing";
import type { VaultKeyData } from "@/lib/storage";

type BillingEntitlementsLike = Partial<Record<EntitlementKey, boolean>> & {
	sentinel?: boolean;
	teamManagement?: boolean;
	vaultSharing?: boolean;
	shareLinks?: boolean;
	billingPortal?: boolean;
	attachments?: boolean;
};

type BillingLimitsLike = {
	shareLinks?: bigint | number | null;
	sharedVaults?: bigint | number | null;
	attachmentMaxFileSizeBytes?: bigint | number | null;
	attachmentStorageBytes?: bigint | number | null;
	share_links?: bigint | number | null;
	shared_vaults?: bigint | number | null;
	attachment_max_file_size_bytes?: bigint | number | null;
	attachment_storage_bytes?: bigint | number | null;
};

type AuthVaultKeyLike = {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	vaultIcon: string | null;
	vaultImageUrl: string | null;
	encryptedVaultKey: string;
	role: string;
};

type VaultListEntryLike = {
	id: string;
	name: string;
	vaultType: string;
	icon: string | null;
	imageUrl: string | null;
	encryptedVaultKey: string;
	role: string;
};

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

export function normalizeVaultType(vaultType: string): "personal" | "team" {
	return vaultType === "team" ? "team" : "personal";
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

export function normalizeVaultRole(
	role: string,
): "owner" | "admin" | "member" | "read-only" {
	switch (role) {
		case "owner":
		case "admin":
		case "member":
		case "read-only":
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

export function normalizeEntitlements(
	entitlements: BillingEntitlementsLike | null | undefined,
): Partial<Record<EntitlementKey, boolean>> {
	return {
		sentinel: entitlements?.sentinel === true,
		team_management:
			entitlements?.team_management === true ||
			entitlements?.teamManagement === true,
		vault_sharing:
			entitlements?.vault_sharing === true ||
			entitlements?.vaultSharing === true,
		share_links:
			entitlements?.share_links === true ||
			entitlements?.shareLinks === true,
		billing_portal:
			entitlements?.billing_portal === true ||
			entitlements?.billingPortal === true,
		attachments: entitlements?.attachments === true,
	};
}

function normalizeNullableNumber(
	value: bigint | number | null | undefined,
): number | null {
	return value == null ? null : Number(value);
}

export function normalizeEntitlementLimits(limits: BillingLimitsLike | null | undefined) {
	return {
		shareLinks: normalizeNullableNumber(limits?.shareLinks ?? limits?.share_links),
		sharedVaults: normalizeNullableNumber(
			limits?.sharedVaults ?? limits?.shared_vaults,
		),
		attachmentMaxFileSizeBytes: normalizeNullableNumber(
			limits?.attachmentMaxFileSizeBytes ??
				limits?.attachment_max_file_size_bytes,
		),
		attachmentStorageBytes: normalizeNullableNumber(
			limits?.attachmentStorageBytes ?? limits?.attachment_storage_bytes,
		),
	};
}

export function normalizeAuthVaultKey(vault: AuthVaultKeyLike): VaultKeyData {
	return {
		vaultId: vault.vaultId,
		vaultName: vault.vaultName,
		vaultType: normalizeVaultType(vault.vaultType),
		vaultIcon: vault.vaultIcon,
		vaultImageUrl: vault.vaultImageUrl,
		encryptedVaultKey: vault.encryptedVaultKey,
		role: normalizeVaultRole(vault.role),
	};
}

export function normalizeVaultListEntry(vault: VaultListEntryLike): VaultKeyData {
	return {
		vaultId: vault.id,
		vaultName: vault.name,
		vaultType: normalizeVaultType(vault.vaultType),
		vaultIcon: vault.icon,
		vaultImageUrl: vault.imageUrl,
		encryptedVaultKey: vault.encryptedVaultKey,
		role: normalizeVaultRole(vault.role),
	};
}