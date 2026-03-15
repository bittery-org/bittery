import { type AppLocale, supportedLocales } from "@bittery/i18n";
import { useTRPC } from "@bittery/shared/trpc";
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
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconClockTimeOutlineDuo18 as Clock,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconFingerprintOutlineDuo18 as Fingerprint,
	IconGear3OutlineDuo18 as Gear,
	IconSquareTerminalOutlineDuo18 as Github,
	IconFlagGermany,
	IconFlagUnitedStates,
	IconKeyOutlineDuo18 as Key,
	IconLockKeyOutlineDuo18 as LockKey,
	IconEnvelopeOutlineDuo18 as Mail,
	IconMobileOutlineDuo18 as Mobile,
	IconMagicShieldOutlineDuo18 as Shield,
	IconTrash2OutlineDuo18 as Trash2,
	IconUpload4OutlineDuo18 as Upload,
	IconUserOutlineDuo18 as User,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { VaultImportDialog } from "@/components/import/vault-import-dialog";
import { AutoLockSettings } from "@/components/settings/auto-lock-settings";
import { ChangeEmailDialog } from "@/components/settings/change-email-dialog";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { DeviceManagement } from "@/components/settings/device-management";
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
	const trpc = useTRPC();
	const { locale, setLocale, m } = useI18n();
	const activeLocaleLabel =
		locale === "en" ? m.i18n_language_en() : m.i18n_language_de();
	const ActiveLocaleFlag =
		locale === "en" ? IconFlagUnitedStates : IconFlagGermany;
	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
	const onboardingImport = useImportOnboardingState();

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5">
				<div className="pointer-events-none absolute inset-0 bg-linear-to-br from-muted/60 via-transparent to-transparent" />

				<div className="relative flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-3">
						<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted shadow-sm sm:h-10 sm:w-10">
							<Gear className="h-4 w-4 text-muted-foreground sm:h-5 sm:w-5" />
						</div>
						<div className="min-w-0">
							<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl">
								{m.settings_page_hero_heading()}
							</h1>
							{userQuery.data?.email && (
								<p className="truncate text-muted-foreground text-xs">
									{userQuery.data.email}
								</p>
							)}
						</div>
					</div>
				</div>
			</section>

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
							<h2 className="font-semibold text-lg tracking-tight">
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
								<div className="rounded-xl border bg-card p-5">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
											<User className="h-4 w-4 text-muted-foreground" />
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
								<div className="rounded-xl border bg-card p-5">
									<div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
										<div className="flex items-center gap-3">
											<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
												<Mail className="h-4 w-4 text-muted-foreground" />
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
								<div className="rounded-xl border bg-card p-5 sm:col-span-2">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
											<Fingerprint className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-muted-foreground text-xs">
												{m.settings_field_secret_key_hint()}
											</p>
											<code className="mt-0.5 inline-block rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground text-sm">
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
							<h2 className="font-semibold text-lg tracking-tight">
								{m.settings_security_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.settings_security_description()}
							</p>
						</div>

						<div className="space-y-3">
							{/* Master Password */}
							<div className="rounded-xl border bg-card p-5">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
											<LockKey className="h-4 w-4 text-muted-foreground" />
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
							<div className="rounded-xl border bg-card p-5">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
											<Key className="h-4 w-4 text-muted-foreground" />
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
							<div className="rounded-xl border bg-card p-5">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
											<Shield className="h-4 w-4 text-muted-foreground" />
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
															className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
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
							<div className="rounded-xl border bg-card p-5">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
											<Clock className="h-4 w-4 text-muted-foreground" />
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
							<h2 className="font-semibold text-lg tracking-tight">
								{m.settings_devices_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.settings_devices_description()}
							</p>
						</div>
						<DeviceManagement />
					</div>
				</TabsContent>

				{/* ── General Tab ── */}
				<TabsContent value="general" className="mt-4">
					<div className="space-y-6">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m.settings_general_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m.settings_general_description()}
							</p>
						</div>

						<div className="rounded-xl border bg-card p-6">
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

						<div className="rounded-xl border bg-card p-5">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-start gap-3">
									<div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
										<Upload className="h-4 w-4 text-muted-foreground" />
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

						<div className="rounded-xl border bg-card p-5">
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

						{/* Danger Zone */}
						<div className="rounded-xl border border-destructive/20 p-5">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-center gap-3">
									<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
										<Trash2 className="h-4 w-4 text-destructive" />
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

			<VaultImportDialog
				open={isImportDialogOpen}
				onOpenChange={setIsImportDialogOpen}
				onImportCompleted={(summary) => {
					if (summary.failedVaultCount === 0) {
						onboardingImport.markCompleted();
					}
				}}
			/>
		</div>
	);
}
