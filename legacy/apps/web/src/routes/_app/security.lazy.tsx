import { useItems } from "@bittery/core/hooks";
import { usePasswordSecurity } from "@bittery/core/hooks/use-password-security";
import { createLazyFileRoute } from "@tanstack/react-router";
import { useDeferredValue, useMemo } from "react";
import { SecurityDashboard } from "@/components/dashboard/security-dashboard";

export const Route = createLazyFileRoute("/_app/security")({
	component: SecurityPage,
});

function SecurityPage() {
	const { items, isLoading } = useItems();

	// Defer items so the skeleton renders immediately while zxcvbn runs in
	// a lower-priority update — avoids blocking first paint.
	const deferredItems = useDeferredValue(items);
	const isAnalysing = deferredItems !== items;

	const report = usePasswordSecurity(deferredItems);

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
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-6">
			<SecurityDashboard
				report={report}
				isLoading={isLoading || isAnalysing}
				vaults={vaults}
			/>
		</div>
	);
}
