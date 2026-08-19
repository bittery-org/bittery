import { useVaultInfo } from "@bittery/core/hooks";
import { VaultAvatar } from "@bittery/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultComponent,
});

function VaultComponent() {
	const { m } = useI18n();
	const { id } = Route.useParams();

	const { vaultInfo: currentVault } = useVaultInfo(id);
	const vaultName =
		currentVault?.vaultName || m.vaults_create_dialog_avatar_fallback();

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
					{m.vaults_shared_empty_no_item_selected()}
				</p>
				<p className="text-muted-foreground text-sm">
					{m.vaults_shared_empty_select_item_to_view_details()}
				</p>
			</div>
		</div>
	);
}
