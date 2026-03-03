/**
 * Shared pricing plan data used by both the web app and marketing site.
 *
 * This module is the single source of truth for plan metadata and feature
 * comparison tables. Apps augment these records with their own icons and
 * platform-specific styling classes.
 */

export { cloudPlanIds, type CloudPlanId } from "@bittery/api/billing/plans";

/* ─── Plan Metadata ──────────────────────────────────────────────── */

export interface PlanInfo {
	id: "free" | "personal" | "family" | "team";
	name: string;
	priceLabel: string;
	priceSuffix?: string;
	description: string;
	isRecommended?: boolean;
}

export const planInfo: PlanInfo[] = [
	{
		id: "free",
		name: "Free",
		priceLabel: "$0",
		description: "Basic vault for getting started.",
	},
	{
		id: "personal",
		name: "Personal",
		priceLabel: "$3",
		priceSuffix: "/mo",
		description: "Daily password security with premium features.",
		isRecommended: true,
	},
	{
		id: "family",
		name: "Family",
		priceLabel: "$7",
		priceSuffix: "/mo",
		description: "Shared protection for your household.",
	},
	{
		id: "team",
		name: "Team",
		priceLabel: "$6",
		priceSuffix: "/user",
		description: "Teams and businesses with shared workspaces.",
	},
];

/** Quick lookup by plan id. */
export const planInfoMap = Object.fromEntries(
	planInfo.map((p) => [p.id, p]),
) as Record<PlanInfo["id"], PlanInfo>;

/* ─── Feature Comparison ─────────────────────────────────────────── */

export interface PlanFeature {
	label: string;
	values: Record<PlanInfo["id"], string | boolean>;
}

export interface FeatureCategory {
	name: string;
	features: PlanFeature[];
}

export const featureCategories: FeatureCategory[] = [
	{
		name: "Vaults & Items",
		features: [
			{
				label: "Vaults",
				values: { free: "1", personal: "Unlimited", family: "Unlimited", team: "Unlimited" },
			},
			{
				label: "Items per vault",
				values: { free: "50", personal: "Unlimited", family: "Unlimited", team: "Unlimited" },
			},
			{
				label: "Item types",
				values: { free: "Logins only", personal: "All types", family: "All types", team: "All types" },
			},
			{
				label: "Storage",
				values: { free: false, personal: "250 MB", family: "1 GB", team: "2 GB" },
			},
			{
				label: "Max file size",
				values: { free: false, personal: "10 MB", family: "25 MB", team: "50 MB" },
			},
		],
	},
	{
		name: "Security",
		features: [
			{
				label: "Zero-knowledge encryption",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Two-factor authentication",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Passkey support",
				values: { free: false, personal: true, family: true, team: true },
			},
			{
				label: "Emergency Kit & Recovery",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Breach monitoring",
				values: { free: false, personal: true, family: true, team: true },
			},
		],
	},
	{
		name: "Sharing & Collaboration",
		features: [
			{
				label: "Secure sharing links",
				values: { free: false, personal: "5 active", family: "Unlimited", team: "Unlimited" },
			},
			{
				label: "Shared vaults",
				values: { free: false, personal: false, family: "5", team: "Unlimited" },
			},
			{
				label: "Team members",
				values: { free: false, personal: false, family: "Up to 6", team: "Unlimited" },
			},
			{
				label: "Role-based access",
				values: { free: false, personal: false, family: true, team: true },
			},
		],
	},
	{
		name: "Apps & Devices",
		features: [
			{
				label: "Web app",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Desktop app",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Browser extension",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Mobile app",
				values: { free: true, personal: true, family: true, team: true },
			},
			{
				label: "Synced devices",
				values: { free: "2", personal: "Unlimited", family: "Unlimited", team: "Unlimited" },
			},
		],
	},
	{
		name: "Admin & Support",
		features: [
			{
				label: "Priority support",
				values: { free: false, personal: true, family: true, team: true },
			},
			{
				label: "Admin console",
				values: { free: false, personal: false, family: false, team: true },
			},
			{
				label: "Activity logs",
				values: { free: false, personal: false, family: false, team: true },
			},
			{
				label: "Custom policies",
				values: { free: false, personal: false, family: false, team: true },
			},
		],
	},
];

/* ─── Marketing Feature Lists (bullet points per plan) ───────────── */

export const planFeatureBullets: Record<PlanInfo["id"], string[]> = {
	free: [
		"1 vault, 50 items",
		"Logins only",
		"Zero-knowledge encryption",
		"Two-factor authentication",
		"All apps & extensions",
		"2 synced devices",
	],
	personal: [
		"Unlimited vaults & items",
		"All item types",
		"250 MB secure storage",
		"Passkeys & breach monitoring",
		"5 active sharing links",
		"Unlimited devices",
		"Priority support",
	],
	family: [
		"Everything in Personal",
		"Unlimited vaults, 5 shared vaults",
		"Up to 6 family members",
		"1 GB secure storage",
		"Unlimited sharing links",
		"Role-based access",
	],
	team: [
		"Everything in Family",
		"Unlimited vaults & members",
		"2 GB secure storage",
		"Admin console",
		"Activity logs",
		"Custom policies",
	],
};
