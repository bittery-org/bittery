import type { CloudPlanId, EntitlementKey } from "@bittery/shared/billing";
import {
	IconHistory as History,
	IconLayoutGrid as Home,
	IconLock as Lock,
	IconBanknote as Money,
	IconSettings as Settings,
	IconShieldCheck as ShieldCheck,
	IconUsers as Users,
} from "@bittery/ui/icons";
import type { ComponentType } from "react";
import type { DeploymentMode } from "@/lib/route-guards";

type NavPath =
	| "/home"
	| "/security"
	| "/billing"
	| "/team"
	| "/admin"
	| "/vaults"
	| "/settings";

type TeamRole = "owner" | "admin" | "member";

type NavIcon = ComponentType<{ className?: string }>;

export interface AppNavItem {
	path: NavPath;
	label: string;
	icon: NavIcon;
	requiresMode: DeploymentMode | "any";
	requiresEntitlements: readonly EntitlementKey[];
	requiresBillingEnabled?: boolean;
	requiresPlans?: readonly CloudPlanId[];
	requiresRoles?: readonly TeamRole[];
}

export interface NavFilterInput {
	mode: DeploymentMode;
	billingEnabled?: boolean;
	entitlements: Partial<Record<EntitlementKey, boolean>>;
	plan?: CloudPlanId;
	role?: TeamRole;
}

export const appNavItems: readonly AppNavItem[] = [
	{
		path: "/home",
		icon: Home,
		label: "Dashboard",
		requiresMode: "any",
		requiresEntitlements: [],
	},
	{
		path: "/security",
		icon: ShieldCheck,
		label: "Sentinel",
		requiresMode: "any",
		requiresEntitlements: ["sentinel"],
	},
	{
		path: "/vaults",
		icon: Lock,
		label: "Vaults",
		requiresMode: "any",
		requiresEntitlements: [],
	},
	{
		path: "/team",
		icon: Users,
		label: "Team",
		requiresMode: "any",
		requiresEntitlements: [],
	},
	{
		path: "/admin",
		icon: History,
		label: "Admin",
		requiresMode: "any",
		requiresEntitlements: ["team_management"],
		requiresPlans: ["team"],
		requiresRoles: ["owner", "admin"],
	},
	{
		path: "/billing",
		icon: Money,
		label: "Billing",
		requiresMode: "cloud",
		requiresBillingEnabled: true,
		requiresEntitlements: [],
		requiresRoles: ["owner", "admin"],
	},
	{
		path: "/settings",
		icon: Settings,
		label: "Settings",
		requiresMode: "any",
		requiresEntitlements: [],
	},
];

export function filterNavItems(
	items: readonly AppNavItem[],
	input: NavFilterInput,
): AppNavItem[] {
	return items.filter((item) => {
		if (item.requiresMode !== "any" && item.requiresMode !== input.mode) {
			return false;
		}
		if (item.requiresBillingEnabled && input.billingEnabled !== true) {
			return false;
		}
		if (item.requiresPlans?.length && input.mode !== "self-hosted") {
			if (!input.plan || !item.requiresPlans.includes(input.plan)) {
				return false;
			}
		}
		if (item.requiresRoles?.length) {
			if (!input.role || !item.requiresRoles.includes(input.role)) {
				return false;
			}
		}
		return item.requiresEntitlements.every(
			(entitlement) => input.entitlements[entitlement],
		);
	});
}
