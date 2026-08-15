/**
 * MIGRATION SCAFFOLD — M1-C5. Placeholder vault landing screen: proves sign-in and unlock
 * land somewhere real. The actual vault screens (item list, detail, etc.) are a later chunk.
 */

import { Button } from "@bittery/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAccount } from "@/contexts/account-context";

export const Route = createFileRoute("/vault/")({
	component: VaultPlaceholder,
});

function VaultPlaceholder() {
	const { activeAccount, lockAllAccounts } = useAccount();
	const navigate = useNavigate();

	const handleLock = async () => {
		await lockAllAccounts();
		navigate({ to: "/unlock" });
	};

	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
			<h1 className="font-semibold text-2xl">Vault</h1>
			<p className="text-muted-foreground">
				{activeAccount?.email ?? "No active account"}
			</p>
			<Button onClick={() => void handleLock()}>Lock</Button>
		</div>
	);
}
