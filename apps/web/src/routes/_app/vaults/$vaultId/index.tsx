import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	ScrollArea,
	Sheet,
	SheetContent,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Key, Users } from "lucide-react";
import { useState } from "react";
import ItemDetail from "@/components/vault/item-detail";
import { ItemList } from "@/components/vault/item-list";
import { AddMemberDialog } from "@/components/vaults/add-member-dialog";
import { VaultMemberList } from "@/components/vaults/vault-member-list";
import { useDecryptedItems } from "@/hooks/use-decrypted-items";
import { useAvailableTags } from "@/hooks/use-vault-tags";

export const Route = createFileRoute("/_app/vaults/$vaultId/")({
	component: VaultDetailPage,
});

function VaultDetailPage() {
	const { vaultId } = Route.useParams();
	const trpc = useTRPC();

	const [selectedItem, setSelectedItem] = useState<DecryptedItem | null>(null);

	const vaultQuery = useQuery(trpc.vault.get.queryOptions({ vaultId }));
	const membersQuery = useQuery(
		trpc.vault.members.list.queryOptions({ vaultId }),
	);

	// Use the new decrypted items hook
	const { items: decryptedItems, isLoading: isLoadingItems } =
		useDecryptedItems(vaultId);

	// Get available tags from decrypted items
	const availableTags = useAvailableTags(decryptedItems);

	const vault = vaultQuery.data;
	const canManage = vault?.userRole === "owner" || vault?.userRole === "admin";
	const canEdit = vault?.userRole !== "read-only";

	const handleItemSelect = (item: DecryptedItem) => {
		setSelectedItem(item);
	};

	const handleCloseSheet = () => {
		setSelectedItem(null);
	};

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
		<div className="flex h-full flex-col gap-6">
			<div className="flex shrink-0 items-center gap-4">
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

			<Tabs defaultValue="items" className="flex min-h-0 flex-1 flex-col">
				<TabsList className="shrink-0">
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

				<TabsContent
					value="items"
					className="mt-4 flex min-h-0 flex-1 flex-col"
				>
					<Card className="flex min-h-0 flex-1 flex-col">
						<CardHeader className="shrink-0">
							<div className="flex items-start justify-between">
								<div>
									<CardTitle>Vault Items</CardTitle>
									<CardDescription>
										Click on an item to view its details.
									</CardDescription>
								</div>
							</div>
						</CardHeader>
						<CardContent className="flex min-h-0 flex-1 flex-col pb-6">
							<ItemList
								items={decryptedItems}
								isLoading={isLoadingItems}
								vaultId={vaultId}
								onItemSelect={handleItemSelect}
								selectedItemId={selectedItem?.id}
							/>
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

			{/* Item Detail Sheet */}
			<Sheet
				open={!!selectedItem}
				onOpenChange={(open) => !open && handleCloseSheet()}
			>
				<SheetContent className="w-full sm:max-w-lg">
					<ScrollArea className="h-full pr-4">
						{selectedItem && (
							<ItemDetail
								category={selectedItem.category}
								data={selectedItem}
								item={selectedItem}
								vaultId={vaultId}
								availableTags={availableTags}
								canEdit={canEdit}
							/>
						)}
					</ScrollArea>
				</SheetContent>
			</Sheet>
		</div>
	);
}
