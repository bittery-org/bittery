import { useTRPC } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	Separator,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import {
	IconClockTimeOutlineDuo18 as Clock,
	IconExternalLinkOutlineDuo18 as ExternalLink,
	IconSquareTerminalOutlineDuo18 as Github,
	IconKeyOutlineDuo18 as Key,
	IconLockKeyOutlineDuo18 as LockKey,
	IconMobileOutlineDuo18 as Mobile,
	IconMagicShieldOutlineDuo18 as Shield,
	IconTrash2OutlineDuo18 as Trash2,
	IconUserOutlineDuo18 as User,
	IconGear3OutlineDuo18 as Gear,
	IconEnvelopeOutlineDuo18 as Mail,
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconFingerprintOutlineDuo18 as Fingerprint,
	IconUpload4OutlineDuo18 as Upload,
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

export const Route = createFileRoute("/_app/settings/")({
	component: SettingsPage,
	head: () => ({
		meta: [{ title: "Settings - Bittery" }],
	}),
});

const GITHUB_REPO = "bittery-org/bittery";

function SettingsPage() {
	const trpc = useTRPC();
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
							Settings
						</Badge>
						<div className="space-y-2">
							<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
								Account Settings
							</h1>
							<p className="max-w-2xl text-muted-foreground">
								Manage your profile, security credentials, connected devices,
								and application preferences.
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
								Account &amp; security preferences
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
						Account
					</TabsTrigger>
					<TabsTrigger value="security">
						<Shield className="mr-2 h-4 w-4" />
						Security
					</TabsTrigger>
					<TabsTrigger value="devices">
						<Mobile className="mr-2 h-4 w-4" />
						Devices
					</TabsTrigger>
					<TabsTrigger value="general">
						<Gear className="mr-2 h-4 w-4" />
						General
					</TabsTrigger>
				</TabsList>

				{/* ── Account Tab ── */}
				<TabsContent value="account" className="mt-4">
					<div className="space-y-6">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								Profile Information
							</h2>
							<p className="text-muted-foreground text-sm">
								Your personal account details.
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
											<p className="text-muted-foreground text-xs">Name</p>
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
											<p className="text-muted-foreground text-xs">Email</p>
											<p className="truncate font-medium text-sm">
												{userQuery.data?.email || "—"}
											</p>
										</div>
										{userQuery.data?.email && (
											<ChangeEmailDialog
												currentEmail={userQuery.data.email}
											/>
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
												Secret Key Hint
											</p>
											<code className="mt-0.5 inline-block rounded bg-muted px-2 py-0.5 font-mono text-muted-foreground text-sm">
												{userQuery.data?.secretKeyHint || "N/A"}
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
								Security Credentials
							</h2>
							<p className="text-muted-foreground text-sm">
								Manage your passwords, keys, and protection settings.
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
												Master Password
											</span>
											<p className="text-muted-foreground text-xs">
												Change your master password. Invalidates your current
												Recovery Key.
											</p>
										</div>
									</div>
									{userQuery.data?.email && (
										<ChangePasswordDialog
											userEmail={userQuery.data.email}
										/>
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
											<span className="font-medium text-sm">Secret Key</span>
											<p className="text-muted-foreground text-xs">
												Generate a new secret key. Invalidates your current
												Recovery Key.
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
														Recovery Key
													</span>
													{userQuery.data?.hasRecoveryKey && (
														<Badge
															variant="outline"
															className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
														>
															<CheckCircle className="mr-1 h-3 w-3" />
															Configured
														</Badge>
													)}
												</div>
												<p className="text-muted-foreground text-xs">
													Reset your password without losing vault data.
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
										<span className="font-medium text-sm">Auto-Lock</span>
										<p className="text-muted-foreground text-xs">
											Lock your vault automatically after inactivity.
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
								Connected Devices
							</h2>
							<p className="text-muted-foreground text-sm">
								Manage devices that have access to your account.
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
								General
							</h2>
							<p className="text-muted-foreground text-sm">
								App information and account management.
							</p>
						</div>

						<div className="rounded-xl border bg-card p-6">
							<div className="space-y-4">
								<p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
									Bittery is a secure, zero-knowledge password manager that puts
									you in control of your data. Your passwords are encrypted
									client-side and never leave your device unencrypted.
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
											GitHub Repository
											<ExternalLink className="ml-2 h-3 w-3" />
										</a>
									</Button>
									<Button variant="outline" size="sm" asChild>
										<a
											href={`https://github.com/${GITHUB_REPO}/issues`}
											target="_blank"
											rel="noopener noreferrer"
										>
											Report an Issue
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
											Import from another password manager
										</span>
										<p className="text-muted-foreground text-xs">
											Reopen the migration flow anytime. Supports 1Password{" "}
											<code>.1pux</code> item import in v1.
										</p>
									</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsImportDialogOpen(true)}
								>
									Open Import
								</Button>
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
										<span className="font-medium text-sm">Delete Account</span>
										<p className="text-muted-foreground text-xs">
											Permanently delete your account and all data. This
											cannot be undone.
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
