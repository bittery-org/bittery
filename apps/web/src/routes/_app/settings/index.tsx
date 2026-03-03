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
		locale === "en" ? m["i18n.language.en"]() : m["i18n.language.de"]();
	const ActiveLocaleFlag =
		locale === "en" ? IconFlagUnitedStates : IconFlagGermany;
	const userQuery = useQuery(trpc.auth.me.queryOptions());
	const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
	const onboardingImport = useImportOnboardingState();

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
				<div className="pointer-events-none absolute inset-0 bg-linear-to-br from-muted/60 via-transparent to-transparent" />
				<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

				<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
					<div className="space-y-4">
						<Badge variant="secondary" className="w-fit">
							{m["settings.page.hero_badge"]()}
						</Badge>
						<div className="space-y-2">
							<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
								{m["settings.page.hero_heading"]()}
							</h1>
							<p className="max-w-2xl text-muted-foreground">
								{m["settings.page.hero_description"]()}
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
							{userQuery.data?.email && (
								<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
									<Mail className="h-3.5 w-3.5" />
									{userQuery.data.email}
								</div>
							)}
							<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
								<Gear className="h-3.5 w-3.5" />
								{m["settings.page.hero_pill"]()}
							</div>
						</div>
					</div>
				</div>
			</section>

			{/* Tabs Area */}
			<Tabs defaultValue="account">
				<TabsList>
					<TabsTrigger value="account">
						<User className="mr-2 h-4 w-4" />
						{m["settings.tab.account"]()}
					</TabsTrigger>
					<TabsTrigger value="security">
						<Shield className="mr-2 h-4 w-4" />
						{m["settings.tab.security"]()}
					</TabsTrigger>
					<TabsTrigger value="devices">
						<Mobile className="mr-2 h-4 w-4" />
						{m["settings.tab.devices"]()}
					</TabsTrigger>
					<TabsTrigger value="general">
						<Gear className="mr-2 h-4 w-4" />
						{m["settings.tab.general"]()}
					</TabsTrigger>
				</TabsList>

				{/* ── Account Tab ── */}
				<TabsContent value="account" className="mt-4">
					<div className="space-y-6">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m["settings.account.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m["settings.account.description"]()}
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
										<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
											<User className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-muted-foreground text-xs">
												{m["settings.field.name"]()}
											</p>
											<p className="truncate font-medium text-sm">
												{userQuery.data?.name || "—"}
											</p>
										</div>
									</div>
								</div>

								{/* Email */}
								<div className="rounded-xl border bg-card p-5">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
											<Mail className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-muted-foreground text-xs">
												{m["settings.field.email"]()}
											</p>
											<p className="truncate font-medium text-sm">
												{userQuery.data?.email || "—"}
											</p>
										</div>
										{userQuery.data?.email && (
											<ChangeEmailDialog currentEmail={userQuery.data.email} />
										)}
									</div>
								</div>

								{/* Secret Key Hint */}
								<div className="rounded-xl border bg-card p-5 sm:col-span-2">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
											<Fingerprint className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="text-muted-foreground text-xs">
												{m["settings.field.secret_key_hint"]()}
											</p>
											<code className="mt-0.5 inline-block rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground text-sm">
												{userQuery.data?.secretKeyHint ||
													m["settings.common.na"]()}
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
								{m["settings.security.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m["settings.security.description"]()}
							</p>
						</div>

						<div className="space-y-3">
							{/* Master Password */}
							<div className="rounded-xl border bg-card p-5">
								<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="flex items-center gap-3">
										<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
											<LockKey className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="space-y-0.5">
											<span className="font-medium text-sm">
												{m["settings.security.master_password"]()}
											</span>
											<p className="text-muted-foreground text-xs">
												{m["settings.security.master_password_description"]()}
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
										<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
											<Key className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="space-y-0.5">
											<span className="font-medium text-sm">
												{m["settings.security.secret_key"]()}
											</span>
											<p className="text-muted-foreground text-xs">
												{m["settings.security.secret_key_description"]()}
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
										<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
											<Shield className="h-4 w-4 text-muted-foreground" />
										</div>
										<div className="flex items-center gap-2">
											<div className="space-y-0.5">
												<div className="flex items-center gap-2">
													<span className="font-medium text-sm">
														{m["settings.security.recovery_key"]()}
													</span>
													{userQuery.data?.hasRecoveryKey && (
														<Badge
															variant="outline"
															className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
														>
															<CheckCircle className="mr-1 h-3 w-3" />
															{m["settings.security.recovery_key_configured"]()}
														</Badge>
													)}
												</div>
												<p className="text-muted-foreground text-xs">
													{m["settings.security.recovery_key_description"]()}
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
								<div className="mb-4 flex items-center gap-3">
									<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
										<Clock className="h-4 w-4 text-muted-foreground" />
									</div>
									<div className="space-y-0.5">
										<span className="font-medium text-sm">
											{m["settings.security.auto_lock"]()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m["settings.security.auto_lock_description"]()}
										</p>
									</div>
								</div>
								<AutoLockSettings />
							</div>
						</div>
					</div>
				</TabsContent>

				{/* ── Devices Tab ── */}
				<TabsContent value="devices" className="mt-4">
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m["settings.devices.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m["settings.devices.description"]()}
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
								{m["settings.general.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m["settings.general.description"]()}
							</p>
						</div>

						<div className="rounded-xl border bg-card p-6">
							<div className="space-y-4">
								<p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
									{m["settings.general.product_description"]()}
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
											{m["settings.general.github_repository"]()}
											<ExternalLink className="ml-2 h-3 w-3" />
										</a>
									</Button>
									<Button variant="outline" size="sm" asChild>
										<a
											href={`https://github.com/${GITHUB_REPO}/issues`}
											target="_blank"
											rel="noopener noreferrer"
										>
											{m["settings.general.report_issue"]()}
											<ExternalLink className="ml-2 h-3 w-3" />
										</a>
									</Button>
								</div>
							</div>
						</div>

						<div className="rounded-xl border bg-card p-5">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="flex items-start gap-3">
									<div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
										<Upload className="h-4 w-4 text-muted-foreground" />
									</div>
									<div className="space-y-1">
										<span className="font-medium text-sm">
											{m["settings.general.import.title"]()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m["settings.general.import.description"]()}
										</p>
									</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsImportDialogOpen(true)}
								>
									{m["settings.general.import.open"]()}
								</Button>
							</div>
						</div>

						<div className="rounded-xl border bg-card p-5">
							<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
								<div className="space-y-0.5">
									<span className="font-medium text-sm">
										{m["settings.general.language.title"]()}
									</span>
									<p className="text-muted-foreground text-xs">
										{m["settings.general.language.description"]()}
									</p>
								</div>
								<Select
									value={locale}
									onValueChange={(value) => setLocale(value as AppLocale)}
								>
									<SelectTrigger
										aria-label={m["settings.general.language.title"]()}
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
															? m["i18n.language.en"]()
															: m["i18n.language.de"]()}
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
									<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/10">
										<Trash2 className="h-4 w-4 text-destructive" />
									</div>
									<div className="space-y-0.5">
										<span className="font-medium text-sm">
											{m["settings.general.danger.delete_account"]()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m[
												"settings.general.danger.delete_account_description"
											]()}
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
