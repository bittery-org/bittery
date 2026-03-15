import { IconLockOutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/")({
	component: VaultComponent,
});

function VaultComponent() {
	const { m } = useI18n();

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<IconLockOutlineDuo18 size={48} className="text-muted-foreground" />
				</div>
				<h3 className="mb-2 font-semibold text-lg">
					{m.vaults_shared_empty_no_vault_selected()}
				</h3>
				<p className="text-muted-foreground text-sm">
					{m.vaults_shared_empty_select_vault_to_view_contents()}
				</p>
			</div>
		</div>
	);
}
