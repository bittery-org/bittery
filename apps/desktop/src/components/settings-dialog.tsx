import {
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	toast,
} from "@bittery/ui";
import { IconLoader2OutlineDuo18 } from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, HardDrive, Shield } from "lucide-react";
import { useState } from "react";
import { SettingsAdvancedPanel } from "@/components/settings/settings-advanced-panel";
import { SettingsGeneralPanel } from "@/components/settings/settings-general-panel";
import { SettingsSecurityPanel } from "@/components/settings/settings-security-panel";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

type SettingsTab = "general" | "security" | "advanced";

const FULL_SCREEN_DIALOG_CLASS =
	"fixed inset-0 z-50 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 sm:max-w-none";

interface SettingsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
	const settingsQuery = useQuery({
		queryKey: ["desktopSettings"],
		queryFn: async () => {
			const [autoLockTimeoutMs, masterPasswordReentryMs] = await Promise.all([
				storage.getAutoLockTimeoutOrDefault(),
				storage.getMasterPasswordReentryPeriodMs(),
			]);
			return { autoLockTimeoutMs, masterPasswordReentryMs };
		},
		enabled: open,
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? (
				settingsQuery.isLoading ? (
					<DialogContent
						className={FULL_SCREEN_DIALOG_CLASS}
						showCloseButton={true}
					>
						<div className="flex flex-1 items-center justify-center">
							<IconLoader2OutlineDuo18 className="h-6 w-6 animate-spin text-muted-foreground" />
						</div>
					</DialogContent>
				) : settingsQuery.data ? (
					<SettingsDialogContent
						onOpenChange={onOpenChange}
						initialAutoLockTimeout={String(
							settingsQuery.data.autoLockTimeoutMs,
						)}
						initialMasterPasswordReentry={String(
							settingsQuery.data.masterPasswordReentryMs,
						)}
					/>
				) : null
			) : null}
		</Dialog>
	);
}

function SettingsDialogContent({
	onOpenChange,
	initialAutoLockTimeout,
	initialMasterPasswordReentry,
}: Pick<SettingsDialogProps, "onOpenChange"> & {
	initialAutoLockTimeout: string;
	initialMasterPasswordReentry: string;
}) {
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const [activeTab, setActiveTab] = useState<SettingsTab>("general");
	const [autoLockTimeout, setAutoLockTimeout] = useState(
		initialAutoLockTimeout,
	);
	const [masterPasswordReentry, setMasterPasswordReentry] = useState(
		initialMasterPasswordReentry,
	);
	const [savedAutoLockTimeout, setSavedAutoLockTimeout] = useState(
		initialAutoLockTimeout,
	);
	const [savedMasterPasswordReentry, setSavedMasterPasswordReentry] = useState(
		initialMasterPasswordReentry,
	);

	const isSecurityDirty =
		autoLockTimeout !== savedAutoLockTimeout ||
		masterPasswordReentry !== savedMasterPasswordReentry;

	const saveMutation = useMutation({
		mutationFn: async ({
			timeout,
			reentryPeriod,
		}: {
			timeout: string;
			reentryPeriod: string;
		}) => {
			const timeoutMs = Number.parseInt(timeout, 10);
			const reentryPeriodMs = Number.parseInt(reentryPeriod, 10);
			await Promise.all([
				storage.storeAutoLockTimeout(timeoutMs),
				storage.storeMasterPasswordReentryPeriodMs(reentryPeriodMs),
			]);
		},
		onSuccess: () => {
			toast.success(m.settings_dialog_toast_saved());
			setSavedAutoLockTimeout(autoLockTimeout);
			setSavedMasterPasswordReentry(masterPasswordReentry);
			queryClient.invalidateQueries({ queryKey: ["desktopSettings"] });
			queryClient.invalidateQueries({ queryKey: ["sessionState"] });
		},
		onError: (error) => {
			console.error("Failed to save desktop settings:", error);
			toast.error(m.settings_dialog_toast_save_failed());
		},
	});

	const handleSave = () => {
		saveMutation.mutate({
			timeout: autoLockTimeout,
			reentryPeriod: masterPasswordReentry,
		});
	};

	const handleClose = () => {
		if (saveMutation.isPending) {
			return;
		}
		onOpenChange(false);
	};

	const isBusy = saveMutation.isPending;
	const showSaveButton = activeTab === "security" && isSecurityDirty;

	const navItems: Array<{
		id: SettingsTab;
		label: string;
		icon: typeof Globe;
	}> = [
		{
			id: "general",
			label: m.settings_tab_general(),
			icon: Globe,
		},
		{
			id: "security",
			label: m.settings_tab_security(),
			icon: Shield,
		},
		{
			id: "advanced",
			label: m.settings_desktop_tab_advanced(),
			icon: HardDrive,
		},
	];

	const panelTitle =
		activeTab === "general"
			? m.settings_tab_general()
			: activeTab === "security"
				? m.settings_tab_security()
				: m.settings_desktop_tab_advanced();

	const panelDescription =
		activeTab === "general"
			? m.settings_desktop_section_general_description()
			: activeTab === "security"
				? m.settings_desktop_section_security_description()
				: m.settings_desktop_section_advanced_description();

	return (
		<DialogContent className={FULL_SCREEN_DIALOG_CLASS} showCloseButton={true}>
			<div className="flex min-h-0 flex-1">
				<aside className="w-56 shrink-0 border-r bg-muted/20 p-3">
					<nav className="space-y-1 pt-10">
						{navItems.map((item) => {
							const Icon = item.icon;
							const isActive = activeTab === item.id;

							return (
								<button
									key={item.id}
									type="button"
									onClick={() => setActiveTab(item.id)}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
										isActive
											? "bg-accent text-accent-foreground"
											: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
									)}
								>
									<Icon className="size-4 shrink-0" />
									<span>{item.label}</span>
								</button>
							);
						})}
					</nav>
				</aside>

				<main className="flex min-h-0 flex-1 flex-col">
					<header className="border-b px-8 py-6">
						<DialogTitle className="text-2xl">{panelTitle}</DialogTitle>
						<DialogDescription className="mt-1">
							{panelDescription}
						</DialogDescription>
					</header>

					<div className="flex-1 overflow-y-auto px-8 py-6">
						<div className="max-w-2xl space-y-8">
							{activeTab === "general" ? <SettingsGeneralPanel /> : null}
							{activeTab === "security" ? (
								<SettingsSecurityPanel
									autoLockTimeout={autoLockTimeout}
									onAutoLockTimeoutChange={setAutoLockTimeout}
									masterPasswordReentry={masterPasswordReentry}
									onMasterPasswordReentryChange={setMasterPasswordReentry}
								/>
							) : null}
							{activeTab === "advanced" ? (
								<SettingsAdvancedPanel disabled={isBusy} />
							) : null}
						</div>
					</div>

					<footer className="flex items-center justify-between border-t px-8 py-4">
						<div className="text-muted-foreground text-sm">
							{showSaveButton ? m.settings_desktop_unsaved_changes() : null}
						</div>
						<div className="flex items-center gap-2">
							<Button variant="outline" onClick={handleClose} disabled={isBusy}>
								{m.settings_common_action_cancel()}
							</Button>
							{showSaveButton ? (
								<Button onClick={handleSave} disabled={isBusy}>
									{saveMutation.isPending ? (
										<>
											<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
											{m.settings_common_action_saving()}
										</>
									) : (
										m.settings_dialog_action_save()
									)}
								</Button>
							) : null}
						</div>
					</footer>
				</main>
			</div>
		</DialogContent>
	);
}
