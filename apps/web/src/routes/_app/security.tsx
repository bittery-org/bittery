import { useItems, usePasswordSecurity } from "@bittery/core/hooks";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { SecurityDashboard } from "@/components/dashboard/security-dashboard";
import { createRouteGuard } from "@/lib/route-guards";

export const Route = createFileRoute("/_app/security")({
	beforeLoad: createRouteGuard({
		requiresMode: "cloud",
		requiresEntitlements: ["sentinel"],
	}),
	component: SecurityPage,
	head: () => ({
		meta: [{ title: "Sentinel - Bittery" }],
	}),
});

function SecurityPage() {
	const { items, isLoading } = useItems();
	const report = usePasswordSecurity(items);

	// Extract unique vaults from items for the security dashboard
	const vaults = useMemo(() => {
		const vaultMap = new Map<string, { id: string; name: string }>();
		for (const item of items) {
			if (item.vault && !vaultMap.has(item.vault.id)) {
				vaultMap.set(item.vault.id, {
					id: item.vault.id,
					name: item.vault.name,
				});
			}
		}
		return Array.from(vaultMap.values());
	}, [items]);

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-6 sm:gap-6">
			<SecurityDashboard
				report={report}
				isLoading={isLoading}
				vaults={vaults}
			/>
		</div>
	);
}
