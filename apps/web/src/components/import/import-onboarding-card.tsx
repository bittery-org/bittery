import {
	Button,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@bittery/ui";
import {
	IconUpload4OutlineDuo18 as Upload,
	IconVault3OutlineDuo18 as Vault,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useState } from "react";
import { useImportOnboardingState } from "@/hooks/use-import-onboarding-state";
import { useI18n } from "@/providers/i18n-provider";
import { VaultImportDialog } from "./vault-import-dialog";

interface ImportOnboardingCardProps {
	isCollapsed: boolean;
}

export function ImportOnboardingCard({
	isCollapsed,
}: ImportOnboardingCardProps) {
	const { m } = useI18n();
	const [isDialogOpen, setIsDialogOpen] = useState(false);
	const { isReady, showCard, markDismissed, markCompleted } =
		useImportOnboardingState();

	if (!isReady || !showCard) {
		return null;
	}

	return (
		<>
			{isCollapsed ? (
				<SidebarMenu className="mb-2">
					<SidebarMenuItem>
						<SidebarMenuButton
							tooltip={m.vaults_import_onboarding_collapsed_tooltip()}
							onClick={() => setIsDialogOpen(true)}
						>
							<Upload />
							<span>{m.vaults_import_onboarding_collapsed_label()}</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			) : (
				<div className="mx-2 mb-2 overflow-hidden rounded-lg border bg-card">
					<div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
						<p className="inline-flex items-center gap-1.5 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.vaults_import_onboarding_badge()}
						</p>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="size-5 text-muted-foreground hover:text-foreground"
							onClick={markDismissed}
						>
							<X className="size-3" />
							<span className="sr-only">
								{m.vaults_import_onboarding_dismiss_sr_label()}
							</span>
						</Button>
					</div>
					<div className="space-y-2 px-2.5 py-2.5">
						<p className="flex items-center gap-1.5 font-medium text-sm">
							<Vault className="size-3.5 text-muted-foreground" />
							{m.vaults_import_onboarding_title()}
						</p>
						<p className="text-muted-foreground text-xs leading-snug">
							{m.vaults_import_onboarding_description()}
						</p>
						<Button
							type="button"
							variant="outline"
							className="h-7 w-full justify-center"
							size="sm"
							onClick={() => setIsDialogOpen(true)}
						>
							<Upload className="size-3.5" />
							{m.vaults_import_onboarding_cta()}
						</Button>
					</div>
				</div>
			)}

			<VaultImportDialog
				open={isDialogOpen}
				onOpenChange={setIsDialogOpen}
				onImportCompleted={(summary) => {
					if (summary.failedVaultCount === 0) {
						markCompleted();
					}
				}}
			/>
		</>
	);
}
