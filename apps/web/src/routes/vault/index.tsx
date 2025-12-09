import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { getVaultKeys } from "@/lib/crypto";

export const Route = createFileRoute("/vault/")({
	component: VaultComponent,
});

function VaultComponent() {
	const vaultKeys = getVaultKeys();
	const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
	// Set first vault as selected by default
	useEffect(() => {
		if (vaultKeys && vaultKeys.length > 0 && !selectedVaultId) {
			setSelectedVaultId(vaultKeys[0].vaultId);
		}
	}, [vaultKeys, selectedVaultId]);

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<Lock size={48} className="text-muted-foreground" />
				</div>
				<h3 className="mb-2 font-semibold text-lg">No vault selected</h3>
				<p className="text-muted-foreground text-sm">
					Please select a vault to view its contents.
				</p>
			</div>
		</div>
	);
}
