import type { VaultItemCounts } from "@bittery/core/hooks";
import {
	Button,
	cn,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	getTagColorFromName,
	SidebarCount,
	SidebarSection,
	VaultAvatar,
} from "@bittery/ui";
import {
	IconBoxArchive3OutlineDuo18 as Archive,
	IconDotsOutlineDuo18 as Dots,
	IconGrid2OutlineDuo18 as Grid,
	IconPen2OutlineDuo18 as Pen,
	IconStarOutlineDuo18 as Star,
	IconTrash2OutlineDuo18 as Trash,
} from "@bittery/ui/icons";
import { useDroppable } from "@dnd-kit/core";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";
import {
	type DragItemData,
	type DropVaultData,
	useVaultDnd,
} from "@/providers/vault-dnd-provider";

interface VaultInfo {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	role: string;
}

interface DroppableVaultEntryProps {
	vault: VaultInfo;
	isActive: boolean;
	count?: number;
	onEditVault: (vault: {
		id: string;
		name: string;
		icon?: string | null;
		imageUrl?: string | null;
	}) => void;
	onDeleteVault: (vault: { id: string; name: string }) => void;
	onNavigate?: () => void;
}

function DroppableVaultEntry({
	vault,
	isActive,
	count,
	onEditVault,
	onDeleteVault,
	onNavigate,
}: DroppableVaultEntryProps) {
	const { m } = useI18n();
	const { isDragging } = useVaultDnd();
	const canEdit = vault.role === "owner" || vault.role === "admin";
	const canDelete = vault.role === "owner";

	const dropData: DropVaultData = {
		type: "vault",
		vaultId: vault.vaultId,
		role: vault.role,
	};

	const { isOver, setNodeRef, active } = useDroppable({
		id: `vault-drop-${vault.vaultId}`,
		data: dropData,
	});

	// Get the source vault ID from the active drag item
	const activeData = active?.data.current as DragItemData | undefined;
	const sourceVaultId = activeData?.sourceVaultId;

	// Determine if this is a valid drop target
	const isSameVault = sourceVaultId === vault.vaultId;
	const isReadOnly = vault.role === "read-only";
	const isValidTarget = isDragging && !isSameVault && !isReadOnly;
	const isInvalidTarget = isDragging && (isSameVault || isReadOnly);

	// Keep drop feedback inside the row; outer rings get clipped by the sidebar scroller.
	let dropBackgroundStyle = "";
	let dropIndicatorStyle = "";
	if (isOver && isValidTarget) {
		dropBackgroundStyle = "bg-success/10";
		dropIndicatorStyle =
			"border-success/70 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-success)_55%,transparent)]";
	} else if (isOver && isInvalidTarget) {
		dropBackgroundStyle = "bg-destructive/10";
		dropIndicatorStyle =
			"border-destructive/70 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-destructive)_55%,transparent)]";
	} else if (isDragging && isValidTarget) {
		dropIndicatorStyle = "border-dashed border-muted-foreground/25";
	}

	return (
		<div
			ref={setNodeRef}
			className={cn(
				"group relative mb-0.5 w-full rounded-sm text-left text-sm transition-colors",
				isActive
					? "bg-selected font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
					: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
				dropBackgroundStyle,
			)}
		>
			{isActive && (
				<span
					aria-hidden
					className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
				/>
			)}
			{dropIndicatorStyle && (
				<div
					className={cn(
						"pointer-events-none absolute inset-px rounded-sm border transition-[border-color,box-shadow]",
						dropIndicatorStyle,
					)}
				/>
			)}
			<Link
				to="/vaults/$vaultId"
				params={{ vaultId: vault.vaultId }}
				className="flex h-7 items-center px-2"
				onClick={onNavigate}
			>
				<div className="flex min-w-0 items-center gap-2">
					<VaultAvatar
						name={vault.vaultName}
						icon={vault.vaultIcon}
						imageUrl={vault.vaultImageUrl}
						size="xs"
					/>
					<div className="truncate">{vault.vaultName}</div>
				</div>
				<SidebarCount
					count={count}
					className={cn(
						"transition-opacity",
						// The "..." menu occupies this spot on hover.
						(canEdit || canDelete) && "group-hover:opacity-0",
					)}
				/>
			</Link>
			{(canEdit || canDelete) && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="absolute top-1/2 right-1 size-5 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100"
							onClick={(e) => e.stopPropagation()}
						>
							<Dots className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{canEdit && (
							<DropdownMenuItem
								onClick={() =>
									onEditVault({
										id: vault.vaultId,
										name: vault.vaultName,
										icon: vault.vaultIcon,
										imageUrl: vault.vaultImageUrl,
									})
								}
							>
								<Pen className="h-4 w-4" />
								{m.vaults_page_card_action_edit_vault()}
							</DropdownMenuItem>
						)}
						{canEdit && canDelete && <DropdownMenuSeparator />}
						{canDelete && (
							<DropdownMenuItem
								variant="destructive"
								onClick={() =>
									onDeleteVault({
										id: vault.vaultId,
										name: vault.vaultName,
									})
								}
							>
								<Trash className="h-4 w-4" />
								{m.vaults_page_card_action_delete_vault()}
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

interface VaultNavSidebarProps {
	vaults: VaultInfo[];
	tags: string[];
	/** Omitted while items load, so counts appear only once they are real. */
	itemCounts?: VaultItemCounts;
	currentVaultId?: string;
	onNewVault: () => void;
	onEditVault: (vault: {
		id: string;
		name: string;
		icon?: string | null;
		imageUrl?: string | null;
	}) => void;
	onDeleteVault: (vault: { id: string; name: string }) => void;
	onNavigate?: () => void;
	/** Reserve room for the app header that floats above the sidebar. */
	hasHeaderInset?: boolean;
}

export function VaultNavSidebar({
	vaults,
	tags,
	itemCounts,
	currentVaultId,
	onNewVault,
	onEditVault,
	onDeleteVault,
	onNavigate,
	hasHeaderInset = false,
}: VaultNavSidebarProps) {
	const { m } = useI18n();
	const location = useLocation();
	const pathname = location.pathname;
	const params = useParams({ strict: false }) as { tagName?: string };

	const isAllItemsActive = pathname === "/vaults" || pathname === "/vaults/";
	const isFavoritesActive = pathname.startsWith("/vaults/favorites");
	const isTrashActive = pathname.startsWith("/vaults/trash");
	const isTagActive = pathname.startsWith("/vaults/tag/");
	const activeTagName =
		isTagActive && params.tagName ? decodeURIComponent(params.tagName) : null;

	const navLinkClass = (active: boolean) =>
		cn(
			"relative flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-sm transition-colors",
			active
				? "bg-selected font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
				: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
		);

	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-sidebar">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_65%)] dark:bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_65%)]"
			/>
			<div
				className={cn(
					"relative flex-1 overflow-y-auto p-2",
					hasHeaderInset && "pt-11 xl:pt-12",
				)}
			>
				{/* All Objects */}
				<Link
					to="/vaults"
					className={cn(navLinkClass(isAllItemsActive), "mb-1")}
					onClick={onNavigate}
				>
					{isAllItemsActive && (
						<span
							aria-hidden
							className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
						/>
					)}
					<Grid
						className={cn(
							"size-3.5",
							isAllItemsActive ? "text-primary" : "text-muted-foreground",
						)}
					/>
					<span>{m.vaults_sidebar_link_all_objects()}</span>
					<SidebarCount count={itemCounts?.total} />
				</Link>

				{/* Favorites */}
				<Link
					to="/vaults/favorites"
					className={cn(navLinkClass(isFavoritesActive), "mb-1")}
					onClick={onNavigate}
				>
					{isFavoritesActive && (
						<span
							aria-hidden
							className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
						/>
					)}
					<Star className="size-3.5 text-yellow-500" fill="currentColor" />
					<span>{m.vaults_favorites_title()}</span>
					<SidebarCount count={itemCounts?.favorites} />
				</Link>

				{/* Vaults Section */}
				<div className="mt-2">
					<SidebarSection
						title={m.nav_item_vaults()}
						storageKey="web-vaults"
						defaultOpen={true}
						onAdd={onNewVault}
					>
						{vaults.map((vault) => {
							const isActive =
								currentVaultId === vault.vaultId &&
								!isAllItemsActive &&
								!isFavoritesActive &&
								!isTrashActive;

							return (
								<DroppableVaultEntry
									key={vault.vaultId}
									vault={vault}
									count={itemCounts && (itemCounts.byVault[vault.vaultId] ?? 0)}
									isActive={isActive}
									onEditVault={onEditVault}
									onDeleteVault={onDeleteVault}
									onNavigate={onNavigate}
								/>
							);
						})}
					</SidebarSection>
				</div>

				{/* Tags Section */}
				{tags.length > 0 && (
					<div className="mt-2">
						<SidebarSection
							title={m.vaults_detail_items_detail_tags_label()}
							storageKey="web-tags"
							defaultOpen={true}
						>
							{tags.map((tagName) => {
								const color = getTagColorFromName(tagName);
								const isActive = activeTagName === tagName;
								return (
									<Link
										key={tagName}
										to="/vaults/tag/$tagName"
										params={{ tagName: encodeURIComponent(tagName) }}
										search={{ itemId: undefined }}
										className={cn(navLinkClass(isActive), "mb-0.5")}
										onClick={onNavigate}
									>
										{isActive && (
											<span
												aria-hidden
												className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
											/>
										)}
										<span
											aria-hidden
											className="mx-[3.5px] size-[7px] shrink-0 rounded-full"
											style={{ backgroundColor: color }}
										/>
										<span className="truncate">{tagName}</span>
									</Link>
								);
							})}
						</SidebarSection>
					</div>
				)}

				{/* Trash */}
				<Link
					to="/vaults/trash"
					className={cn(navLinkClass(isTrashActive), "mt-2")}
					onClick={onNavigate}
				>
					{isTrashActive && (
						<span
							aria-hidden
							className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
						/>
					)}
					<Archive
						className={cn(
							"size-3.5",
							isTrashActive ? "text-primary" : "text-muted-foreground",
						)}
					/>
					<span>{m.vaults_sidebar_link_archive()}</span>
				</Link>
			</div>
		</div>
	);
}
