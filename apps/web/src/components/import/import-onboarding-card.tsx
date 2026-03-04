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
								tooltip={m["vaults.import.onboarding.collapsed_tooltip"]()}
								onClick={() => setIsDialogOpen(true)}
							>
								<Upload />
								<span>{m["vaults.import.onboarding.collapsed_label"]()}</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
			) : (
				<div className="mx-2 mb-2 overflow-hidden rounded-xl border border-primary/12 bg-gradient-to-br from-primary/7 via-primary/3 to-sidebar-background/85">
					<div className="flex items-center justify-between gap-2 border-sidebar-border/50 border-b px-2.5 py-2">
							<p className="inline-flex items-center gap-1.5 text-[10px] text-sidebar-foreground/80 uppercase tracking-[0.13em]">
								<span className="h-1.5 w-1.5 rounded-full bg-primary" />
								{m["vaults.import.onboarding.badge"]()}
							</p>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							className="h-5 w-5 text-sidebar-foreground/70 hover:bg-sidebar-background/40 hover:text-sidebar-foreground"
							onClick={markDismissed}
							>
								<X className="h-3 w-3" />
								<span className="sr-only">
									{m["vaults.import.onboarding.dismiss_sr_label"]()}
								</span>
							</Button>
						</div>
						<div className="space-y-2 px-2.5 py-2.5">
							<p className="flex items-center gap-1.5 font-semibold text-sm">
								<Vault className="h-3.5 w-3.5 text-primary" />
								{m["vaults.import.onboarding.title"]()}
							</p>
							<p className="text-sidebar-foreground/75 text-xs leading-snug">
								{m["vaults.import.onboarding.description"]()}
							</p>
						<Button
							type="button"
							variant="outline"
							className="h-7 w-full justify-center border-primary/18 bg-sidebar-background/60 text-[11px] shadow-none"
							size="sm"
							onClick={() => setIsDialogOpen(true)}
							>
								<Upload className="mr-1.5 h-3.5 w-3.5" />
								{m["vaults.import.onboarding.cta"]()}
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
