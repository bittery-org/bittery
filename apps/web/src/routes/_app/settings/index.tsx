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
import { ExternalLink, Github, User } from "lucide-react";

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
							<div className="grid gap-1">
								<span className="font-medium text-sm">Email</span>
								<span className="text-muted-foreground">
									{userQuery.data?.email}
								</span>
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

			<Card>
				<CardHeader>
					<CardTitle>Security</CardTitle>
					<CardDescription>Manage your security settings</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-muted-foreground text-sm">
						Security settings like password change and two-factor authentication
						are managed in the desktop app for enhanced security.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
