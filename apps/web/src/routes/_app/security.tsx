import { createFileRoute } from "@tanstack/react-router";
import { SecurityDashboard } from "@/components/dashboard/security-dashboard";
import { useAllDecryptedItems } from "@/hooks/use-all-decrypted-items";
import { usePasswordSecurity } from "@/hooks/use-password-security";

export const Route = createFileRoute("/_app/security")({
	component: SecurityPage,
});

function SecurityPage() {
	const { items, vaults, isLoading } = useAllDecryptedItems();
	const report = usePasswordSecurity(items);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="font-bold text-3xl tracking-tight">
					Security Dashboard
				</h1>
				<p className="text-muted-foreground">
					Analyze your password security and get recommendations for
					improvement.
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
