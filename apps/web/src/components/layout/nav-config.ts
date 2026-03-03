import type { EntitlementKey } from "@bittery/api/billing/entitlements";
import type { CloudPlanId } from "@bittery/api/billing/plans";
import {
	IconHistoryOutlineDuo18 as History,
	IconGrid2OutlineDuo18 as Home,
	IconLockOutlineDuo18 as Lock,
	IconMoneyDollarOutlineDuo18 as Money,
	IconGear3OutlineDuo18 as Settings,
	IconMagicShieldOutlineDuo18 as ShieldCheck,
	IconUsers6OutlineDuo18 as Users,
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
	requiresPlans?: readonly CloudPlanId[];
	requiresRoles?: readonly TeamRole[];
}

export interface NavFilterInput {
	mode: DeploymentMode;
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
		requiresMode: "cloud",
		requiresEntitlements: ["sentinel"],
	},
	{
		path: "/billing",
		icon: Money,
		label: "Billing",
		requiresMode: "cloud",
		requiresEntitlements: [],
		requiresRoles: ["owner", "admin"],
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
		requiresMode: "cloud",
		requiresEntitlements: ["team_management"],
		requiresPlans: ["team"],
		requiresRoles: ["owner", "admin"],
	},
	{
		path: "/vaults",
		icon: Lock,
		label: "Vaults",
		requiresMode: "any",
		requiresEntitlements: [],
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
		if (item.requiresPlans?.length) {
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
