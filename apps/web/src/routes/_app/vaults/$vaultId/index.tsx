import {
	useAvailableTags,
	useVaultInfo,
	useVaultItems,
} from "@bittery/core/hooks";
import { useTRPC } from "@bittery/shared/trpc";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	Badge,
	Button,
	Sheet,
	SheetContent,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	useSidebar,
} from "@bittery/ui";
import {
	IconArrowLeftOutlineDuo18 as ArrowLeft,
	IconKeyOutlineDuo18 as Key,
	IconLockOutlineDuo18 as Lock,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import ItemDetail from "@/components/vault/item-detail";
import { ItemList } from "@/components/vault/item-list";
import { AddMemberDialog } from "@/components/vaults/add-member-dialog";
import { VaultMemberList } from "@/components/vaults/vault-member-list";

export const Route = createFileRoute("/_app/vaults/$vaultId/")({
	component: VaultDetailPage,
	head: () => ({
		meta: [{ title: "Vault - Bittery" }],
	}),
});

function VaultDetailPage() {
	const { vaultId } = Route.useParams();
	const trpc = useTRPC();

	const { state: sidebarState, isMobile } = useSidebar();
	const [selectedItem, setSelectedItem] = useState<DecryptedItem | null>(null);
	const [showCompactHeader, setShowCompactHeader] = useState(false);
	const headerRef = useRef<HTMLElement>(null);

	// Use core hooks for vault metadata and items (local-first, same as desktop)
	const { vaultInfo, isLoading: isLoadingVault } = useVaultInfo(vaultId);
	const { items: decryptedItems, isLoading: isLoadingItems } =
		useVaultItems(vaultId);

	// Observe main header visibility to show compact fixed header on scroll
	useEffect(() => {
		if (isLoadingVault) {
			setShowCompactHeader(false);
			return;
		}

		const el = headerRef.current;
		if (!el) return;

		// Find nearest scrollable ancestor (the overflow-y-auto container)
		let scrollParent: HTMLElement | null = el.parentElement;
		while (scrollParent) {
			const overflow = getComputedStyle(scrollParent).overflowY;
			if (
				overflow === "auto" ||
				overflow === "scroll" ||
				overflow === "overlay"
			) {
				break;
			}
			scrollParent = scrollParent.parentElement;
		}

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry) setShowCompactHeader(!entry.isIntersecting);
			},
			{ root: scrollParent, threshold: 0 },
		);

		observer.observe(el);
		return () => observer.disconnect();
	}, [isLoadingVault]);

	// Members still come from tRPC (no local hook for membership data)
	const membersQuery = useQuery(
		trpc.vault.members.list.queryOptions({ vaultId }),
	);

	// Get available tags from decrypted items
	const availableTags = useAvailableTags(decryptedItems);

	const role = vaultInfo?.role;
	const canManage = role === "owner" || role === "admin";
	const canEdit = role !== "read-only";
	const itemCount = decryptedItems.length;
	const memberCount = membersQuery.data?.length ?? 0;

	const handleItemSelect = (item: DecryptedItem) => {
		setSelectedItem(item);
	};

	const handleCloseSheet = () => {
		setSelectedItem(null);
	};

	if (isLoadingVault) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-6">
				<Skeleton className="h-48 w-full rounded-2xl" />
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (!vaultInfo) {
		return (
			<div className="flex flex-col items-center gap-3 py-12 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
					<Lock className="h-6 w-6 text-muted-foreground" />
				</div>
				<p className="text-muted-foreground">Vault not found</p>
				<Link to="/vaults" className="text-primary text-sm hover:underline">
					Back to vaults
				</Link>
			</div>
		);
	}

	const roleBadgeVariant =
		role === "owner" ? "default" : role === "admin" ? "secondary" : "outline";

	const compactHeaderLeft = isMobile
		? "0px"
		: sidebarState === "expanded"
			? "var(--sidebar-width)"
			: "calc(var(--sidebar-width-icon) + 1.5rem)";

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Compact fixed header (visible on scroll) */}
			<div
				className={`fixed top-0 right-0 z-50 flex h-11 items-center border-b bg-background/80 backdrop-blur-sm transition-[left,opacity,transform] duration-200 ${
					showCompactHeader && vaultInfo
						? "translate-y-0 opacity-100"
						: "pointer-events-none -translate-y-full opacity-0"
				}`}
				style={{ left: compactHeaderLeft }}
			>
				<div className="mx-auto flex h-full w-full max-w-6xl items-center justify-between pr-5 pl-14 lg:pr-6 lg:pl-16 xl:pl-6">
					{vaultInfo && (
						<>
							<div className="flex items-center gap-2.5">
								<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border bg-muted/50">
									{vaultInfo.vaultType === "team" ? (
										<Users className="h-3.5 w-3.5 text-muted-foreground" />
									) : (
										<Lock className="h-3.5 w-3.5 text-muted-foreground" />
									)}
								</div>
								<span className="font-medium text-sm">
									{vaultInfo.vaultName}
								</span>
								<Badge
									variant={roleBadgeVariant}
									className="px-1.5 py-0 text-[11px] capitalize"
								>
									{role}
								</Badge>
							</div>
							<Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
								<Link to="/vaults">
									<ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
									All Vaults
								</Link>
							</Button>
						</>
					)}
				</div>
			</div>

			{/* Header */}
			<section
				ref={headerRef}
				className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7 lg:rounded-xl lg:p-5"
			>
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent lg:from-muted/30" />

				<div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
					<div className="flex items-start gap-5 lg:items-center lg:gap-3.5">
						<div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm lg:h-10 lg:w-10 lg:rounded-lg">
							{vaultInfo.vaultType === "team" ? (
								<Users className="h-7 w-7 text-muted-foreground lg:h-5 lg:w-5" />
							) : (
								<Lock className="h-7 w-7 text-muted-foreground lg:h-5 lg:w-5" />
							)}
						</div>
						<div className="space-y-3 lg:space-y-0.5">
							<div className="flex flex-wrap items-center gap-2 lg:hidden">
								<Badge variant="secondary" className="capitalize">
									{vaultInfo.vaultType} vault
								</Badge>
								<Badge variant={roleBadgeVariant} className="capitalize">
									{role}
								</Badge>
							</div>
							<div className="space-y-1.5 lg:space-y-0">
								<div className="flex items-center gap-2.5">
									<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl lg:font-semibold lg:text-xl">
										{vaultInfo.vaultName}
									</h1>
									<div className="hidden items-center gap-1.5 lg:flex">
										<Badge
											variant="secondary"
											className="px-1.5 py-0 text-[11px] capitalize"
										>
											{vaultInfo.vaultType}
										</Badge>
										<Badge
											variant={roleBadgeVariant}
											className="px-1.5 py-0 text-[11px] capitalize"
										>
											{role}
										</Badge>
									</div>
								</div>
								<p className="text-muted-foreground lg:text-xs">
									{itemCount} item{itemCount !== 1 ? "s" : ""} · {memberCount}{" "}
									member
									{memberCount !== 1 ? "s" : ""}
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs lg:hidden">
								<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
									<Key className="h-3.5 w-3.5" />
									{itemCount} item{itemCount !== 1 ? "s" : ""} encrypted
								</div>
								<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
									<Users className="h-3.5 w-3.5" />
									{memberCount} member
									{memberCount !== 1 ? "s" : ""}
								</div>
							</div>
						</div>
					</div>

					<div className="flex flex-wrap gap-2 lg:justify-end">
						<Button
							variant="outline"
							size="default"
							className="lg:h-8 lg:px-3 lg:text-xs"
							asChild
						>
							<Link to="/vaults">
								<ArrowLeft className="mr-2 h-4 w-4 lg:mr-1.5 lg:h-3.5 lg:w-3.5" />
								All Vaults
							</Link>
						</Button>
						{canManage && vaultInfo.vaultType === "team" && (
							<AddMemberDialog vaultId={vaultId} />
						)}
					</div>
				</div>
			</section>

			{/* Tabs Area */}
			<Tabs defaultValue="items" className="flex min-h-0 flex-1 flex-col">
				<TabsList className="w-fit shrink-0">
					<TabsTrigger value="items">
						<Key className="mr-2 h-4 w-4" />
						Items
					</TabsTrigger>
					<TabsTrigger value="members">
						<Users className="mr-2 h-4 w-4" />
						Members
						{memberCount > 1 && (
							<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								{memberCount}
							</span>
						)}
					</TabsTrigger>
				</TabsList>

				<TabsContent
					value="items"
					className="mt-4 flex min-h-0 flex-1 flex-col"
				>
					<div className="flex min-h-0 flex-1 flex-col space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								Vault Items
							</h2>
							<p className="text-muted-foreground text-sm">
								Click on an item to view its details.
							</p>
						</div>
						<div className="min-h-0 flex-1">
							<ItemList
								items={decryptedItems}
								isLoading={isLoadingItems}
								vaultId={vaultId}
								onItemSelect={handleItemSelect}
								selectedItemId={selectedItem?.id}
							/>
						</div>
					</div>
				</TabsContent>

				<TabsContent value="members" className="mt-4">
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								Vault Members
							</h2>
							<p className="text-muted-foreground text-sm">
								{canManage
									? "Manage who has access and their permissions."
									: "People who have access to this vault."}
							</p>
						</div>
						{membersQuery.isLoading ? (
							<div className="grid gap-3 sm:grid-cols-2">
								<Skeleton className="h-28" />
								<Skeleton className="h-28" />
							</div>
						) : (
							<VaultMemberList
								vaultId={vaultId}
								members={membersQuery.data || []}
								userRole={role ?? "member"}
							/>
						)}
					</div>

					{vaultInfo.vaultType === "personal" && (
						<div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed p-5 text-muted-foreground text-sm">
							<Lock className="h-5 w-5 shrink-0" />
							<p>
								This is a personal vault. To share access with others, convert
								it to a team vault in the desktop app.
							</p>
						</div>
					)}
				</TabsContent>
			</Tabs>

			{/* Item Detail Sheet */}
			<Sheet
				open={!!selectedItem}
				onOpenChange={(open) => !open && handleCloseSheet()}
			>
				<SheetContent className="w-full min-w-0 sm:max-w-2xl">
					<div className="h-full min-w-0 overflow-y-auto">
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
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}
