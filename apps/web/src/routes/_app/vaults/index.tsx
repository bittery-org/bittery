import { useTRPC } from "@bittery/shared/trpc";
import {
	Badge,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Lock, Users } from "lucide-react";

export const Route = createFileRoute("/_app/vaults/")({
	component: VaultsPage,
});

function VaultsPage() {
	const trpc = useTRPC();
	const vaultsQuery = useQuery(trpc.vault.list.queryOptions());

	return (
		<div className="space-y-6">
			<div>
				<h1 className="font-bold text-3xl tracking-tight">Vaults</h1>
				<p className="text-muted-foreground">
					View and manage your password vaults.
				</p>
			</div>

			{vaultsQuery.isLoading ? (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{[1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-32" />
					))}
				</div>
			) : vaultsQuery.data?.length === 0 ? (
				<div className="rounded-lg border border-dashed p-8 text-center">
					<h3 className="font-medium text-lg">No vaults yet</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						Create a vault in the desktop app to get started.
					</p>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{vaultsQuery.data?.map((vault) => (
						<Link
							key={vault.id}
							to="/vaults/$vaultId"
							params={{ vaultId: vault.id }}
						>
							<Card className="cursor-pointer transition-colors hover:bg-muted/50">
								<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
									<CardTitle className="flex items-center gap-2 font-medium text-lg">
										<Lock className="h-4 w-4" />
										{vault.name}
									</CardTitle>
									<Badge
										variant={vault.role === "owner" ? "default" : "secondary"}
									>
										{vault.role}
									</Badge>
								</CardHeader>
								<CardContent>
									<div className="flex items-center gap-4 text-muted-foreground text-sm">
										<div className="flex items-center gap-1">
											{vault.type === "team" ? (
												<Users className="h-4 w-4" />
											) : (
												<Lock className="h-4 w-4" />
											)}
											<span className="capitalize">{vault.type}</span>
										</div>
										<span>·</span>
										<span>
											{vault.items?.length || 0} item
											{(vault.items?.length || 0) !== 1 ? "s" : ""}
										</span>
									</div>
								</CardContent>
							</Card>
						</Link>
					))}
				</div>
			)}

			<Card>
				<CardHeader>
					<CardTitle>Managing Vaults</CardTitle>
					<CardDescription>
						Click on a vault to view items and manage access.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-muted-foreground text-sm">
						The desktop app provides features like creating vaults, adding
						items, auto-fill, and biometric unlock. This web dashboard lets you
						view vault contents and manage who has access to each vault.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
