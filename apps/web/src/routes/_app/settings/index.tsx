import { useTRPC } from "@bittery/shared/trpc";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Separator,
	Skeleton,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
	Clock,
	ExternalLink,
	Github,
	Key,
	Monitor,
	Shield,
	Trash2,
	User,
} from "lucide-react";
import { AutoLockSettings } from "@/components/settings/auto-lock-settings";
import { ChangeEmailDialog } from "@/components/settings/change-email-dialog";
import { ChangePasswordDialog } from "@/components/settings/change-password-dialog";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";
import { DeviceManagement } from "@/components/settings/device-management";
import { RegenerateSecretKeyDialog } from "@/components/settings/regenerate-secret-key-dialog";

export const Route = createFileRoute("/_app/settings/")({
	component: SettingsPage,
});

// Replace with your actual GitHub repo
const GITHUB_REPO = "bittery-org/bittery";

function SettingsPage() {
	const trpc = useTRPC();
	const userQuery = useQuery(trpc.auth.me.queryOptions());

	return (
		<div className="space-y-6">
			<div>
				<h1 className="font-bold text-3xl tracking-tight">Settings</h1>
				<p className="text-muted-foreground">
					Manage your account and application settings.
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<User className="h-5 w-5" />
						Account
					</CardTitle>
					<CardDescription>Your account information</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{userQuery.isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-4 w-48" />
						</div>
					) : (
						<>
							<div className="grid gap-1">
								<span className="font-medium text-sm">Name</span>
								<span className="text-muted-foreground">
									{userQuery.data?.name}
								</span>
							</div>
							<Separator />
							<div className="flex items-center justify-between">
								<div className="grid gap-1">
									<span className="font-medium text-sm">Email</span>
									<span className="text-muted-foreground">
										{userQuery.data?.email}
									</span>
								</div>
								{userQuery.data?.email && (
									<ChangeEmailDialog currentEmail={userQuery.data.email} />
								)}
							</div>
							<Separator />
							<div className="grid gap-1">
								<span className="font-medium text-sm">Secret Key Hint</span>
								<code className="w-fit rounded bg-muted px-2 py-1 text-muted-foreground text-sm">
									{userQuery.data?.secretKeyHint || "N/A"}
								</code>
							</div>
						</>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Shield className="h-5 w-5" />
						Security
					</CardTitle>
					<CardDescription>Manage your security settings</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<Key className="h-4 w-4 text-muted-foreground" />
								<span className="font-medium text-sm">Master Password</span>
							</div>
							<p className="text-muted-foreground text-sm">
								Change your master password. Your private key will be
								re-encrypted.
							</p>
						</div>
						{userQuery.data?.email && (
							<ChangePasswordDialog userEmail={userQuery.data.email} />
						)}
					</div>

					<Separator />

					<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<Key className="h-4 w-4 text-muted-foreground" />
								<span className="font-medium text-sm">Secret Key</span>
							</div>
							<p className="text-muted-foreground text-sm">
								Generate a new secret key. Your old key will no longer work.
							</p>
						</div>
						{userQuery.data?.email && (
							<RegenerateSecretKeyDialog userEmail={userQuery.data.email} />
						)}
					</div>

					<Separator />

					<div className="flex items-center gap-2 mb-2">
						<Clock className="h-4 w-4 text-muted-foreground" />
						<span className="font-medium text-sm">Auto-Lock</span>
					</div>
					<AutoLockSettings />
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Monitor className="h-5 w-5" />
						Devices
					</CardTitle>
					<CardDescription>
						Manage devices that have access to your account
					</CardDescription>
				</CardHeader>
				<CardContent>
					<DeviceManagement />
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Github className="h-5 w-5" />
						About Bittery
					</CardTitle>
					<CardDescription>Open-source password manager</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-muted-foreground text-sm">
						Bittery is a secure, zero-knowledge password manager that puts you
						in control of your data. Your passwords are encrypted client-side
						and never leave your device unencrypted.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" asChild>
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
						<Button variant="outline" asChild>
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
				</CardContent>
			</Card>

			<Card className="border-destructive/50">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-destructive">
						<Trash2 className="h-5 w-5" />
						Danger Zone
					</CardTitle>
					<CardDescription>
						Irreversible actions that affect your account
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="space-y-1">
							<span className="font-medium text-sm">Delete Account</span>
							<p className="text-muted-foreground text-sm">
								Permanently delete your account and all associated data. This
								action cannot be undone.
							</p>
						</div>
						{userQuery.data?.email && (
							<DeleteAccountDialog userEmail={userQuery.data.email} />
						)}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
