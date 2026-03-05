import { useVaultInfo } from "@bittery/core/hooks";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";
import { VaultAvatar } from "../../../components/vault/vault-avatar";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultComponent,
});

function VaultComponent() {
	const { m } = useI18n();
	const { id } = Route.useParams();

	const { vaultInfo: currentVault } = useVaultInfo(id);
	const vaultName =
		currentVault?.vaultName || m["vaults.create_dialog.avatar_fallback"]();

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex">
					<VaultAvatar
						name={vaultName}
						icon={currentVault?.vaultIcon}
						imageUrl={currentVault?.vaultImageUrl}
						size="lg"
					/>
				</div>
				<h3 className="mb-2 font-semibold text-lg">{vaultName}</h3>
				<p className="text-muted-foreground text-sm">
					{m["vaults.shared.empty.no_item_selected"]()}
				</p>
				<p className="text-muted-foreground text-sm">
					{m["vaults.shared.empty.select_item_to_view_details"]()}
				</p>
			</div>
		</div>
	);
}
