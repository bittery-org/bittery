import type { VaultItemCounts, VaultKeyWithAccount } from "@bittery/core/hooks";
import {
	Button,
	cn,
	type DragItemData,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	type DropVaultData,
	getTagColorFromName,
	SidebarCount,
	SidebarSection,
	VaultAvatar,
} from "@bittery/ui";
import {
	IconEllipsis,
	IconLayoutGrid,
	IconPencil,
	IconStar,
	IconTrash,
} from "@bittery/ui/icons";
import { useDroppable } from "@dnd-kit/core";
import { Link, useLocation } from "@tanstack/react-router";
import { useVaultDnd } from "../../providers/dnd-provider";
import { useI18n } from "../../providers/i18n-provider";
import { AccountSwitcher } from "../account-switcher";

/**
 * What one sidebar row renders: the vault fields of a held vault key, and nothing else.
 * Narrowed from the canonical `VaultKeyWithAccount` so the sidebar never asks for the
 * wrapped key material or the account metadata it does not group by.
 */
type SidebarVault = Pick<
	VaultKeyWithAccount,
	| "vaultId"
	| "vaultName"
	| "vaultType"
	| "vaultIcon"
	| "vaultImageUrl"
	| "role"
	| "accountId"
>;

interface VaultSidebarProps {
	vaults: readonly SidebarVault[];
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
}

interface DroppableVaultEntryProps {
	vault: SidebarVault;
	isActive: boolean;
	count?: number;
	onEditVault: (vault: {
		id: string;
		name: string;
		icon?: string | null;
		imageUrl?: string | null;
	}) => void;
	onDeleteVault: (vault: { id: string; name: string }) => void;
}

function DroppableVaultEntry({
	vault,
	isActive,
	count,
	onEditVault,
	onDeleteVault,
}: DroppableVaultEntryProps) {
	const { m } = useI18n();
	const { activeItem } = useVaultDnd();

	const dropData: DropVaultData = {
		type: "vault",
		vaultId: vault.vaultId,
		role: vault.role,
		accountId: vault.accountId,
	};

	const { isOver, setNodeRef, active } = useDroppable({
		id: `vault-drop-${vault.vaultId}`,
		data: dropData,
	});

	// Get the source vault ID from the active drag item
	const activeData = active?.data.current as DragItemData | undefined;
	const sourceVaultId = activeData?.sourceVaultId;

	// Determine if this is a valid drop target
	const isDragging = !!activeItem;
	const isSameVault = sourceVaultId === vault.vaultId;
	const isReadOnly = vault.role === "read-only";
	const isValidTarget = isDragging && !isSameVault && !isReadOnly;
	const isInvalidTarget = isDragging && (isSameVault || isReadOnly);

	// Keep drop feedback inside the row; outer rings get clipped by the sidebar scroller.
	let dropBackgroundStyle = "";
	let dropIndicatorStyle = "";
	if (isOver && isValidTarget) {
		dropBackgroundStyle = "bg-emerald-500/10";
		dropIndicatorStyle =
			"border-emerald-500/70 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.55)]";
	} else if (isOver && isInvalidTarget) {
		dropBackgroundStyle = "bg-destructive/10";
		dropIndicatorStyle =
			"border-destructive/70 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.55)]";
	} else if (isDragging && isValidTarget) {
		dropIndicatorStyle = "border-dashed border-muted-foreground/25";
	}

	return (
		<div
			ref={setNodeRef}
			className={cn(
				"group",
				"relative",
				"mb-0.5",
				"w-full",
				"rounded-sm",
				"text-left",
				"text-sm",
				"transition-colors",
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
						"pointer-events-none",
						"absolute",
						"inset-px",
						"rounded-sm",
						"border",
						"transition-[border-color,box-shadow]",
						dropIndicatorStyle,
					)}
				/>
			)}
			<Link
				to="/vault/$id"
				params={{ id: vault.vaultId }}
				className="flex h-7 items-center px-2"
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
						// The owner "..." menu occupies this spot on hover.
						vault.role === "owner" && "group-hover:opacity-0",
					)}
				/>
			</Link>
			{vault.role === "owner" && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="absolute top-1/2 right-1 size-5 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100"
							onClick={(e) => e.stopPropagation()}
						>
							<IconEllipsis className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
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
							<IconPencil className="h-4 w-4" />
							{m.vaults_page_card_action_edit_vault()}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onClick={() =>
								onDeleteVault({
									id: vault.vaultId,
									name: vault.vaultName,
								})
							}
						>
							<IconTrash className="h-4 w-4" />
							{m.vaults_page_card_action_delete_vault()}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

export function VaultSidebar({
	vaults,
	tags,
	itemCounts,
	currentVaultId,
	onNewVault,
	onEditVault,
	onDeleteVault,
}: VaultSidebarProps) {
	const { m } = useI18n();
	const location = useLocation();
	const pathname = location.pathname;

	// Check which section is active
	const isAllItemsActive = pathname.startsWith("/vault/all-items");
	const isFavoritesActive = pathname.startsWith("/vault/favorites");
	const isTrashActive = pathname.startsWith("/vault/trash");
	const isTagActive = pathname.startsWith("/vault/tag/");
	const activeTagName = isTagActive
		? decodeURIComponent(pathname.split("/vault/tag/")[1]?.split("/")[0] || "")
		: null;

	const renderVaultEntry = (vault: SidebarVault) => (
		<DroppableVaultEntry
			key={vault.vaultId}
			vault={vault}
			count={itemCounts && (itemCounts.byVault[vault.vaultId] ?? 0)}
			isActive={
				currentVaultId === vault.vaultId &&
				!isAllItemsActive &&
				!isFavoritesActive &&
				!isTrashActive &&
				!isTagActive
			}
			onEditVault={onEditVault}
			onDeleteVault={onDeleteVault}
		/>
	);

	return (
		<div className="relative flex w-54 flex-col border-r bg-sidebar pt-10">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 top-0 h-44 bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_65%)] dark:bg-[radial-gradient(120%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_65%)]"
			/>
			<div className="absolute inset-x-0 top-0 h-9" data-tauri-drag-region />
			{/* Account Switcher - Fixed at top */}
			<div className="relative px-2 pt-1.5 pb-0.5">
				<AccountSwitcher />
			</div>

			{/* Scrollable sidebar content */}
			<div className="relative flex flex-1 flex-col overflow-y-auto p-2">
				{/* All Objects */}
				<Link
					to="/vault/all-items"
					className={cn(
						"relative",
						"mb-1",
						"flex",
						"h-7",
						"w-full",
						"items-center",
						"gap-2",
						"rounded-sm",
						"px-2",
						"text-left",
						"text-sm",
						"transition-colors",
						isAllItemsActive
							? "bg-selected font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
							: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
					)}
				>
					{isAllItemsActive && (
						<span
							aria-hidden
							className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
						/>
					)}
					<IconLayoutGrid
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
					to="/vault/favorites"
					className={cn(
						"relative",
						"mb-1",
						"flex",
						"h-7",
						"w-full",
						"items-center",
						"gap-2",
						"rounded-sm",
						"px-2",
						"text-left",
						"text-sm",
						"transition-colors",
						isFavoritesActive
							? "bg-selected font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
							: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
					)}
				>
					{isFavoritesActive && (
						<span
							aria-hidden
							className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
						/>
					)}
					<IconStar className="size-3.5 text-yellow-500" fill="currentColor" />
					<span>{m.vaults_favorites_title()}</span>
					<SidebarCount count={itemCounts?.favorites} />
				</Link>

				{/* Vaults Section */}
				<div className="mt-2">
					<SidebarSection
						title={m.nav_item_vaults()}
						storageKey="vaults"
						defaultOpen={true}
						onAdd={onNewVault}
					>
						{vaults.map(renderVaultEntry)}
					</SidebarSection>
				</div>

				{/* Tags Section */}
				{tags.length > 0 && (
					<div className="mt-2">
						<SidebarSection
							title={m.vaults_detail_items_detail_tags_label()}
							storageKey="tags"
							defaultOpen={true}
						>
							{tags.map((tagName) => {
								const color = getTagColorFromName(tagName);
								const isActive = activeTagName === tagName;
								return (
									<Link
										key={tagName}
										to="/vault/tag/$tagName"
										params={{ tagName: encodeURIComponent(tagName) }}
										className={cn(
											"relative",
											"mb-0.5",
											"flex",
											"h-7",
											"w-full",
											"items-center",
											"gap-2",
											"rounded-sm",
											"px-2",
											"text-left",
											"text-sm",
											"transition-colors",
											isActive
												? "bg-selected font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
												: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
										)}
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
			</div>

			{/* Trash — pinned at the bottom */}
			<div className="relative border-t p-2">
				<Link
					to="/vault/trash"
					className={cn(
						"relative",
						"flex",
						"h-7",
						"w-full",
						"items-center",
						"gap-2",
						"rounded-sm",
						"px-2",
						"text-left",
						"text-sm",
						"transition-colors",
						isTrashActive
							? "bg-selected font-medium text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
							: "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
					)}
				>
					{isTrashActive && (
						<span
							aria-hidden
							className="absolute top-[6px] bottom-[6px] -left-2 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
						/>
					)}
					<IconTrash
						className={cn(
							"size-3.5",
							isTrashActive ? "text-primary" : "text-muted-foreground",
						)}
					/>
					<span>{m.vaults_sidebar_link_trash()}</span>
				</Link>
			</div>
		</div>
	);
}
