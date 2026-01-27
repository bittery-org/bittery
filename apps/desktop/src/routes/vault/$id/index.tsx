import { useVaultInfo } from "@bittery/hooks";
import { createFileRoute } from "@tanstack/react-router";
import { VaultAvatar } from "../../../components/vault/vault-avatar";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultComponent,
});

function VaultComponent() {
	const { id } = Route.useParams();

	const { vaultInfo: currentVault } = useVaultInfo(id);

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex">
					<VaultAvatar
						name={currentVault?.vaultName || "Vault"}
						icon={currentVault?.vaultIcon}
						imageUrl={currentVault?.vaultImageUrl}
						size="lg"
					/>
				</div>
				<h3 className="mb-2 font-semibold text-lg">
					{currentVault?.vaultName || "Vault"}
				</h3>
				<p className="text-muted-foreground text-sm">No item selected</p>
				<p className="text-muted-foreground text-sm">
					Please select an item from the list to view its details.
				</p>
			</div>
		</div>
	);
}
