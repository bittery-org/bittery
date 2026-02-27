import type { EntitlementKey } from "@bittery/api/billing/entitlements";
import {
	IconGear3OutlineDuo18 as Settings,
	IconGrid2OutlineDuo18 as Home,
	IconLockOutlineDuo18 as Lock,
	IconMagicShieldOutlineDuo18 as ShieldCheck,
	IconMoneyDollarOutlineDuo18 as Money,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import type { ComponentType } from "react";
import type { DeploymentMode } from "@/lib/route-guards";

type NavPath = "/home" | "/security" | "/billing" | "/team" | "/vaults" | "/settings";

type NavIcon = ComponentType<{ className?: string }>;

export interface AppNavItem {
	path: NavPath;
	label: string;
	icon: NavIcon;
	requiresMode: DeploymentMode | "any";
	requiresEntitlements: readonly EntitlementKey[];
}

export interface NavFilterInput {
	mode: DeploymentMode;
	entitlements: Partial<Record<EntitlementKey, boolean>>;
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
	},
	{
		path: "/team",
		icon: Users,
		label: "Team",
		requiresMode: "any",
		requiresEntitlements: [],
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
		return item.requiresEntitlements.every(
			(entitlement) => input.entitlements[entitlement],
		);
	});
}
