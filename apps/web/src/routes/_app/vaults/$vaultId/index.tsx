import { useTRPC } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Key, Lock, Users } from "lucide-react";
import { AddMemberDialog } from "@/components/vaults/add-member-dialog";
import { VaultMemberList } from "@/components/vaults/vault-member-list";

export const Route = createFileRoute("/_app/vaults/$vaultId/")({
	component: VaultDetailPage,
});

function VaultDetailPage() {
	const { vaultId } = Route.useParams();
	const trpc = useTRPC();

	const vaultQuery = useQuery(trpc.vault.get.queryOptions({ vaultId }));
	const membersQuery = useQuery(
		trpc.vault.members.list.queryOptions({ vaultId }),
	);
	const itemsQuery = useQuery(trpc.vault.listItems.queryOptions({ vaultId }));

	const vault = vaultQuery.data;
	const canManage = vault?.userRole === "owner" || vault?.userRole === "admin";

	if (vaultQuery.isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (!vault) {
		return (
			<div className="py-8 text-center">
				<p className="text-muted-foreground">Vault not found</p>
				<Link to="/vaults" className="text-primary hover:underline">
					Back to vaults
				</Link>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<Link to="/vaults">
					<Button variant="ghost" size="icon">
						<ArrowLeft className="h-4 w-4" />
					</Button>
				</Link>
				<div className="flex-1">
					<div className="flex items-center gap-3">
						<h1 className="font-bold text-3xl tracking-tight">{vault.name}</h1>
						<Badge
							variant={vault.userRole === "owner" ? "default" : "secondary"}
						>
							{vault.userRole}
						</Badge>
					</div>
					<p className="text-muted-foreground">
						{vault.itemCount} item{vault.itemCount !== 1 ? "s" : ""} ·{" "}
						{vault.memberCount} member{vault.memberCount !== 1 ? "s" : ""} ·{" "}
						<span className="capitalize">{vault.type}</span> vault
					</p>
				</div>
			</div>

			<Tabs defaultValue="items">
				<TabsList>
					<TabsTrigger value="items">
						<Key className="mr-2 h-4 w-4" />
						Items
					</TabsTrigger>
					<TabsTrigger value="members">
						<Users className="mr-2 h-4 w-4" />
						Members
						{vault.memberCount > 1 && (
							<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								{vault.memberCount}
							</span>
						)}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="items" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Vault Items</CardTitle>
							<CardDescription>
								Items stored in this vault. Use the desktop app to view and edit
								item details.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{itemsQuery.isLoading ? (
								<Skeleton className="h-32" />
							) : itemsQuery.data?.length === 0 ? (
								<p className="py-4 text-center text-muted-foreground">
									No items in this vault yet.
								</p>
							) : (
								<div className="space-y-2">
									{itemsQuery.data?.map((item) => {
										const overview = item.overview as {
											title: string;
											url?: string;
											username?: string;
										};
										return (
											<div
												key={item.id}
												className="flex items-center gap-3 rounded-lg border p-3"
											>
												<div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
													{item.category === "login" ? (
														<Key className="h-5 w-5 text-muted-foreground" />
													) : (
														<Lock className="h-5 w-5 text-muted-foreground" />
													)}
												</div>
												<div className="min-w-0 flex-1">
													<div className="truncate font-medium">
														{overview.title}
													</div>
													{overview.username && (
														<div className="truncate text-muted-foreground text-sm">
															{overview.username}
														</div>
													)}
												</div>
												<Badge variant="outline" className="capitalize">
													{item.category.replace("-", " ")}
												</Badge>
											</div>
										);
									})}
								</div>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="members" className="mt-4">
					<Card>
						<CardHeader>
							<div className="flex items-start justify-between">
								<div>
									<CardTitle>Vault Members</CardTitle>
									<CardDescription>
										{canManage
											? "Manage who has access to this vault and their permissions."
											: "People who have access to this vault."}
									</CardDescription>
								</div>
								{canManage && vault.type === "team" && (
									<AddMemberDialog vaultId={vaultId} />
								)}
							</div>
						</CardHeader>
						<CardContent>
							{membersQuery.isLoading ? (
								<Skeleton className="h-32" />
							) : (
								<VaultMemberList
									vaultId={vaultId}
									members={membersQuery.data || []}
									userRole={vault.userRole}
								/>
							)}
						</CardContent>
					</Card>

					{vault.type === "personal" && (
						<Card className="mt-4">
							<CardHeader>
								<CardTitle>Personal Vault</CardTitle>
								<CardDescription>
									This is a personal vault. To share access with others, convert
									it to a team vault in the desktop app.
								</CardDescription>
							</CardHeader>
						</Card>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}
