import { type AppLocale, supportedLocales } from "@bittery/i18n";
import { useRPC } from "@bittery/shared/rpc";
import {
	Badge,
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	Separator,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import {
	IconCircleCheck as CheckCircle,
	IconClock as Clock,
	IconArchiveRestore as Download,
	IconExternalLink as ExternalLink,
	IconFingerprint as Fingerprint,
	IconSettings as Gear,
	IconSquareTerminal as Github,
	IconFlagGermany,
	IconFlagUnitedStates,
	IconKey as Key,
	IconLockKeyhole as LockKey,
	IconMail as Mail,
	IconSmartphone as Mobile,
	IconShieldCheck as Shield,
	IconTrash as Trash2,
	IconUpload as Upload,
	IconUser as User,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { VaultExportDialog } from "@/components/export/vault-export-dialog";
import { VaultImportDialog } from "@/components/import/vault-import-dialog";
import { AutoLockSettings } from "@/components/settings/auto-lock-settings";
import { ChangeEmailDialog } from "@/components/settings/change-email-dialog";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { DeviceManagement } from "@/components/settings/device-management";
import { WebDeviceSetupDialog } from "@/components/settings/device-setup-dialog";
import { RegenerateRecoveryKeyDialog } from "@/components/settings/regenerate-recovery-key-dialog";
import { RegenerateSecretKeyDialog } from "@/components/settings/regenerate-secret-key-dialog";
import { SetupRecoveryKeyDialog } from "@/components/settings/setup-recovery-key-dialog";
import { useImportOnboardingState } from "@/hooks/use-import-onboarding-state";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/settings/")({
	component: SettingsPage,
	head: () => ({
		meta: [{ title: "Settings - Bittery" }],
	}),
});

const GITHUB_REPO = "bittery-org/bittery";

function SettingsPage() {
	const rpc = useRPC();
	const { locale, setLocale, m } = useI18n();
	const { theme, setTheme } = useTheme();
	const activeLocaleLabel =
		locale === "en" ? m.i18n_language_en() : m.i18n_language_de();
	const ActiveLocaleFlag =
		locale === "en" ? IconFlagUnitedStates : IconFlagGermany;
	const userQuery = useQuery(rpc.auth.me.queryOptions());
	const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
	const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
	const [isDeviceSetupDialogOpen, setIsDeviceSetupDialogOpen] = useState(false);
	const onboardingImport = useImportOnboardingState();

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Header */}
			<div className="flex items-center gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
					<Gear className="size-4" />
				</div>
				<div className="min-w-0">
					<h1 className="truncate font-semibold text-lg tracking-[-0.015em]">
						{m.settings_page_hero_heading()}
					</h1>
					{userQuery.data?.email && (
						<p className="truncate text-muted-foreground text-xs">
							{userQuery.data.email}
						</p>
					)}
				</div>
			</div>

			{/* Tabs Area */}
			<Tabs defaultValue="account">
				<TabsList className="w-full sm:w-fit">
					<TabsTrigger value="account" className="flex-1 sm:flex-none">
						<User className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">{m.settings_tab_account()}</span>
					</TabsTrigger>
					<TabsTrigger value="security" className="flex-1 sm:flex-none">
						<Shield className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">
							{m.settings_tab_security()}
						</span>
					</TabsTrigger>
					<TabsTrigger value="devices" className="flex-1 sm:flex-none">
						<Mobile className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">{m.settings_tab_devices()}</span>
					</TabsTrigger>
					<TabsTrigger value="general" className="flex-1 sm:flex-none">
						<Gear className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">{m.settings_tab_general()}</span>
					</TabsTrigger>
				</TabsList>

				{/* ── Account Tab ── */}
				<TabsContent value="account" className="mt-4">
					<div className="space-y-6">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.settings_account_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.settings_account_description()}
							</p>
						</div>

						{userQuery.isLoading ? (
							<div className="grid gap-4 sm:grid-cols-2">
								<Skeleton className="h-28" />
								<Skeleton className="h-28" />
								<Skeleton className="h-28" />
							</div>
						) : (
							<div className="grid gap-4 sm:grid-cols-2">
								{/* Name */}
								<div className="rounded-lg border bg-card p-4">
									<div className="flex items-center gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
											<User className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-muted-foreground text-xs">
												{m.settings_field_name()}
											</p>
											<p className="truncate font-medium text-sm">
												{userQuery.data?.name || "—"}
											</p>
										</div>
									</div>
								</div>

								{/* Email */}
								<div className="rounded-lg border bg-card p-4">
									<div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
										<div className="flex items-center gap-3">
											<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
												<Mail className="size-4" />
											</div>
											<div className="min-w-0 flex-1">
												<p className="text-muted-foreground text-xs">
													{m.settings_field_email()}
												</p>
												<p className="truncate font-medium text-sm">
													{userQuery.data?.email || "—"}
												</p>
											</div>
										</div>
										{userQuery.data?.email && (
											<ChangeEmailDialog currentEmail={userQuery.data.email} />
										)}
									</div>
								</div>

								{/* Secret Key Hint */}
								<div className="rounded-lg border bg-card p-4 sm:col-span-2">
									<div className="flex items-center gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
											<Fingerprint className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-muted-foreground text-xs">
												{m.settings_field_secret_key_hint()}
											</p>
											<code className="mt-0.5 inline-block rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
												{userQuery.data?.secretKeyHint ||
													m.settings_common_na()}
											</code>
										</div>
									</div>
								</div>
							</div>
						)}
					</div>
				</TabsContent>

				{/* ── Security Tab ── */}
				<TabsContent value="security" className="mt-4">
					<div className="space-y-6">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.settings_security_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.settings_security_description()}
							</p>
						</div>

						<div className="space-y-3">
							{/* Master Password */}
							<div className="rounded-lg border bg-card p-4">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
											<LockKey className="size-4" />
										</div>
										<div className="space-y-0.5">
											<span className="font-medium text-sm">
												{m.settings_security_master_password()}
											</span>
											<p className="text-muted-foreground text-xs">
												{m.settings_security_master_password_description()}
											</p>
										</div>
									</div>
									{userQuery.data?.email && (
										<ChangePasswordDialog userEmail={userQuery.data.email} />
									)}
								</div>
							</div>

							{/* Secret Key */}
							<div className="rounded-lg border bg-card p-4">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
											<Key className="size-4" />
										</div>
										<div className="space-y-0.5">
											<span className="font-medium text-sm">
												{m.settings_security_secret_key()}
											</span>
											<p className="text-muted-foreground text-xs">
												{m.settings_security_secret_key_description()}
											</p>
										</div>
									</div>
									{userQuery.data?.email && (
										<RegenerateSecretKeyDialog
											userEmail={userQuery.data.email}
										/>
									)}
								</div>
							</div>

							{/* Recovery Key */}
							<div className="rounded-lg border bg-card p-4">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
											<Shield className="size-4" />
										</div>
										<div className="flex items-center gap-2">
											<div className="space-y-0.5">
												<div className="flex items-center gap-2">
													<span className="font-medium text-sm">
														{m.settings_security_recovery_key()}
													</span>
													{userQuery.data?.hasRecoveryKey && (
														<Badge
															variant="outline"
															className="border-success/30 bg-success/10 text-[10.5px] text-success"
														>
															<CheckCircle className="mr-1 h-3 w-3" />
															{m.settings_security_recovery_key_configured()}
														</Badge>
													)}
												</div>
												<p className="text-muted-foreground text-xs">
													{m.settings_security_recovery_key_description()}
												</p>
											</div>
										</div>
									</div>
									{userQuery.data?.email &&
										(userQuery.data.hasRecoveryKey ? (
											<RegenerateRecoveryKeyDialog
												userEmail={userQuery.data.email}
											/>
										) : (
											<SetupRecoveryKeyDialog
												userEmail={userQuery.data.email}
											/>
										))}
								</div>
							</div>

							{/* Auto-Lock */}
							<div className="rounded-lg border bg-card p-4">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
											<Clock className="size-4" />
										</div>
										<div className="space-y-0.5">
											<span className="font-medium text-sm">
												{m.settings_security_auto_lock()}
											</span>
											<p className="text-muted-foreground text-xs">
												{m.settings_security_auto_lock_description()}
											</p>
										</div>
									</div>
									<AutoLockSettings />
								</div>
							</div>
						</div>
					</div>
				</TabsContent>

				{/* ── Devices Tab ── */}
				<TabsContent value="devices" className="mt-4">
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.settings_devices_heading()}
							</h2>
							<div className="flex items-center gap-3">
								<p className="text-muted-foreground text-sm">
									{m.settings_devices_description()}
								</p>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsDeviceSetupDialogOpen(true)}
								>
									{m.settings_devices_action_setup_another()}
								</Button>
							</div>
						</div>
						<DeviceManagement />
					</div>
				</TabsContent>

				{/* ── General Tab ── */}
				<TabsContent value="general" className="mt-4">
					<div className="space-y-6">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.settings_general_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.settings_general_description()}
							</p>
						</div>

						<div className="rounded-lg border bg-card p-4">
							<div className="space-y-4">
								<p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
									{m.settings_general_product_description()}
								</p>
								<Separator />
								<div className="flex flex-wrap gap-2">
									<Button variant="outline" size="sm" asChild>
										<a
											href={`https://github.com/${GITHUB_REPO}`}
											target="_blank"
											rel="noopener noreferrer"
										>
											<Github className="mr-2 h-4 w-4" />
											{m.settings_general_github_repository()}
											<ExternalLink className="ml-2 h-3 w-3" />
										</a>
									</Button>
									<Button variant="outline" size="sm" asChild>
										<a
											href={`https://github.com/${GITHUB_REPO}/issues`}
											target="_blank"
											rel="noopener noreferrer"
										>
											{m.settings_general_report_issue()}
											<ExternalLink className="ml-2 h-3 w-3" />
										</a>
									</Button>
								</div>
							</div>
						</div>

						<div className="rounded-lg border bg-card p-4">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-start gap-3">
									<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
										<Upload className="size-4" />
									</div>
									<div className="space-y-1">
										<span className="font-medium text-sm">
											{m.settings_general_import_title()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m.settings_general_import_description()}
										</p>
									</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsImportDialogOpen(true)}
								>
									{m.settings_general_import_open()}
								</Button>
							</div>
						</div>

						<div className="rounded-lg border bg-card p-4">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-start gap-3">
									<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
										<Download className="size-4" />
									</div>
									<div className="space-y-1">
										<span className="font-medium text-sm">
											{m.settings_general_export_title()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m.settings_general_export_description()}
										</p>
									</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsExportDialogOpen(true)}
								>
									{m.settings_general_export_open()}
								</Button>
							</div>
						</div>

						<div className="rounded-lg border bg-card p-4">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="space-y-0.5">
									<span className="font-medium text-sm">
										{m.settings_general_language_title()}
									</span>
									<p className="text-muted-foreground text-xs">
										{m.settings_general_language_description()}
									</p>
								</div>
								<Select
									value={locale}
									onValueChange={(value) => setLocale(value as AppLocale)}
								>
									<SelectTrigger
										aria-label={m.settings_general_language_title()}
										className="h-7 min-w-28 max-w-30 border-0 bg-transparent px-1.5 text-sm shadow-none ring-0 focus:ring-0"
									>
										<ActiveLocaleFlag size={14} className="shrink-0" />
										<span className="truncate">{activeLocaleLabel}</span>
									</SelectTrigger>
									<SelectContent className="min-w-40">
										{supportedLocales.map((value) => (
											<SelectItem key={value} value={value} className="gap-2">
												<span className="inline-flex items-center gap-2 whitespace-nowrap">
													{value === "en" ? (
														<IconFlagUnitedStates
															size={14}
															className="shrink-0"
														/>
													) : (
														<IconFlagGermany size={14} className="shrink-0" />
													)}
													<span>
														{value === "en"
															? m.i18n_language_en()
															: m.i18n_language_de()}
													</span>
												</span>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						<div className="rounded-lg border bg-card p-4">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="space-y-0.5">
									<span className="font-medium text-sm">
										{m.settings_general_appearance_title()}
									</span>
									<p className="text-muted-foreground text-xs">
										{m.settings_general_appearance_description()}
									</p>
								</div>
								<Select value={theme} onValueChange={setTheme}>
									<SelectTrigger
										aria-label={m.settings_general_appearance_title()}
										className="h-7 min-w-28 max-w-30 border-0 bg-transparent px-1.5 text-sm shadow-none ring-0 focus:ring-0"
									>
										{theme === "dark" ? (
											<Moon className="size-3.5 shrink-0" />
										) : theme === "light" ? (
											<Sun className="size-3.5 shrink-0" />
										) : (
											<Monitor className="size-3.5 shrink-0" />
										)}
										<span className="truncate">
											{theme === "dark"
												? m.settings_theme_dark()
												: theme === "light"
													? m.settings_theme_light()
													: m.settings_theme_system()}
										</span>
									</SelectTrigger>
									<SelectContent className="min-w-40">
										<SelectItem value="light" className="gap-2">
											<span className="inline-flex items-center gap-2 whitespace-nowrap">
												<Sun className="size-3.5 shrink-0" />
												<span>{m.settings_theme_light()}</span>
											</span>
										</SelectItem>
										<SelectItem value="dark" className="gap-2">
											<span className="inline-flex items-center gap-2 whitespace-nowrap">
												<Moon className="size-3.5 shrink-0" />
												<span>{m.settings_theme_dark()}</span>
											</span>
										</SelectItem>
										<SelectItem value="system" className="gap-2">
											<span className="inline-flex items-center gap-2 whitespace-nowrap">
												<Monitor className="size-3.5 shrink-0" />
												<span>{m.settings_theme_system()}</span>
											</span>
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>

						{/* Danger Zone */}
						<div className="rounded-lg border border-destructive/20 p-4">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-center gap-3">
									<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
										<Trash2 className="size-4" />
									</div>
									<div className="space-y-0.5">
										<span className="font-medium text-sm">
											{m.settings_general_danger_delete_account()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m.settings_general_danger_delete_account_description()}
										</p>
									</div>
								</div>
								{userQuery.data?.email && (
									<DeleteAccountDialog userEmail={userQuery.data.email} />
								)}
							</div>
						</div>
					</div>
				</TabsContent>
			</Tabs>

			<VaultExportDialog
				open={isExportDialogOpen}
				onOpenChange={setIsExportDialogOpen}
			/>
			<VaultImportDialog
				open={isImportDialogOpen}
				onOpenChange={setIsImportDialogOpen}
				onImportCompleted={(summary) => {
					if (summary.failedVaultCount === 0) {
						onboardingImport.markCompleted();
					}
				}}
			/>
			<WebDeviceSetupDialog
				open={isDeviceSetupDialogOpen}
				onOpenChange={setIsDeviceSetupDialogOpen}
			/>
		</div>
	);
}
