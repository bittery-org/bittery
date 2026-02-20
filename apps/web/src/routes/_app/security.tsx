import { useItems, usePasswordSecurity } from "@bittery/core/hooks";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { SecurityDashboard } from "@/components/dashboard/security-dashboard";

export const Route = createFileRoute("/_app/security")({
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
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			<div>
				<h1 className="font-bold text-3xl tracking-tight">Sentinel</h1>
				<p className="text-muted-foreground">
					Monitor password health, track threats, and follow prioritized
					guidance to strengthen every account.
				</p>
			</div>

			<SecurityDashboard
				report={report}
				isLoading={isLoading}
				vaults={vaults}
			/>
		</div>
	);
}
