import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@bittery/ui";
import { useDroppable } from "@dnd-kit/core";
import { Link, useLocation } from "@tanstack/react-router";
import {
	Archive,
	FileUp,
	LayoutGrid,
	MoreHorizontal,
	Pencil,
	Star,
	Tag,
	Trash2,
} from "lucide-react";
import {
	type DragItemData,
	type DropVaultData,
	useVaultDnd,
} from "../../providers/dnd-provider";
import { SidebarSection } from "./sidebar-section";
import { getTagColorFromName } from "./tag-badge";
import { VaultAvatar } from "./vault-avatar";

interface VaultInfo {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	role: string;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
}

interface VaultSidebarProps {
	vaults: VaultInfo[];
	tags: string[];
	currentVaultId?: string;
	onNewVault: () => void;
	onEditVault: (vault: { id: string; name: string }) => void;
	onDeleteVault: (vault: { id: string; name: string }) => void;
	onImportItems?: (vaultId: string) => void;
}

interface DroppableVaultEntryProps {
	vault: VaultInfo;
	isActive: boolean;
	onEditVault: (vault: { id: string; name: string }) => void;
	onDeleteVault: (vault: { id: string; name: string }) => void;
	onImportItems?: (vaultId: string) => void;
}

function DroppableVaultEntry({
	vault,
	isActive,
	onEditVault,
	onDeleteVault,
	onImportItems,
}: DroppableVaultEntryProps) {
	const { activeItem } = useVaultDnd();

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
	const isDragging = !!activeItem;
	const isSameVault = sourceVaultId === vault.vaultId;
	const isReadOnly = vault.role === "read-only";
	const isValidTarget = isDragging && !isSameVault && !isReadOnly;
	const isInvalidTarget = isDragging && (isSameVault || isReadOnly);

	// Visual feedback styles
	let ringStyle = "";
	if (isOver && isValidTarget) {
		ringStyle = "ring-2 ring-green-500 bg-green-500/10";
	} else if (isOver && isInvalidTarget) {
		ringStyle = "ring-2 ring-red-500 bg-red-500/10";
	} else if (isDragging && isValidTarget) {
		ringStyle = "ring-1 ring-muted-foreground/30";
	}

	return (
		<div
			ref={setNodeRef}
			className={`group relative mb-0.5 w-full rounded-md text-left text-sm transition-colors ${
				isActive ? "bg-muted/60" : "hover:bg-muted/30"
			} ${ringStyle}`}
		>
			<Link
				to="/vault/$id"
				params={{ id: vault.vaultId }}
				className="block px-3 py-2"
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
			</Link>
			{vault.role === "owner" && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="absolute top-1/2 right-1 h-5 w-5 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100"
							onClick={(e) => e.stopPropagation()}
						>
							<MoreHorizontal className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							onClick={() =>
								onEditVault({
									id: vault.vaultId,
									name: vault.vaultName,
								})
							}
						>
							<Pencil className="mr-2 h-4 w-4" />
							Rename
						</DropdownMenuItem>
						{onImportItems && (
							<DropdownMenuItem onClick={() => onImportItems(vault.vaultId)}>
								<FileUp className="mr-2 h-4 w-4" />
								Import Items
							</DropdownMenuItem>
						)}
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
							<Trash2 className="mr-2 h-4 w-4" />
							Delete
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
	currentVaultId,
	onNewVault,
	onEditVault,
	onDeleteVault,
	onImportItems,
}: VaultSidebarProps) {
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

	// Check if we're in multi-account mode (vaults have accountEmail)
	const isMultiAccountMode = vaults.length > 0 && vaults[0].accountEmail;

	// Group vaults by account if in multi-account mode
	const vaultsByAccount = isMultiAccountMode
		? vaults.reduce(
				(acc, vault) => {
					const email = vault.accountEmail;
					if (!email) return acc;
					if (!acc[email]) {
						acc[email] = {
							accountEmail: email,
							accountName: vault.accountName || email.split("@")[0],
							accountTeamName: vault.accountTeamName,
							vaults: [],
						};
					}
					acc[email].vaults.push(vault);
					return acc;
				},
				{} as Record<
					string,
					{
						accountEmail: string;
						accountName: string;
						accountTeamName?: string;
						vaults: VaultInfo[];
					}
				>,
			)
		: null;

	const renderVaultEntry = (vault: VaultInfo) => (
		<DroppableVaultEntry
			key={vault.vaultId}
			vault={vault}
			isActive={
				currentVaultId === vault.vaultId &&
				!isAllItemsActive &&
				!isFavoritesActive &&
				!isTrashActive &&
				!isTagActive
			}
			onEditVault={onEditVault}
			onDeleteVault={onDeleteVault}
			onImportItems={onImportItems}
		/>
	);

	return (
		<div className="flex w-48 flex-col border-r bg-background">
			<div className="flex flex-1 flex-col overflow-y-auto p-2">
				{/* All Objects */}
				<Link
					to="/vault/all-items"
					className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
						isAllItemsActive ? "bg-muted/60" : "hover:bg-muted/30"
					}`}
				>
					<LayoutGrid className="size-4 text-muted-foreground" />
					<span>All Objects</span>
				</Link>

				{/* Favorites */}
				<Link
					to="/vault/favorites"
					className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
						isFavoritesActive ? "bg-muted/60" : "hover:bg-muted/30"
					}`}
				>
					<Star className="size-4 text-yellow-500" fill="currentColor" />
					<span>Favorites</span>
				</Link>

				{/* Vaults Section */}
				<div className="mt-2">
					{isMultiAccountMode && vaultsByAccount ? (
						// Multi-account mode: Group vaults by account
						Object.values(vaultsByAccount).map((accountGroup) => (
							<SidebarSection
								key={accountGroup.accountEmail}
								title={accountGroup.accountTeamName || accountGroup.accountName}
								storageKey={`account-${accountGroup.accountEmail}`}
								defaultOpen={true}
							>
								{accountGroup.vaults.map(renderVaultEntry)}
							</SidebarSection>
						))
					) : (
						// Single account mode: Show vaults in one section
						<SidebarSection
							title="Vaults"
							storageKey="vaults"
							defaultOpen={true}
							onAdd={onNewVault}
						>
							{vaults.map(renderVaultEntry)}
						</SidebarSection>
					)}
				</div>

				{/* Tags Section */}
				{tags.length > 0 && (
					<div className="mt-2">
						<SidebarSection title="Tags" storageKey="tags" defaultOpen={true}>
							{tags.map((tagName) => {
								const color = getTagColorFromName(tagName);
								const isActive = activeTagName === tagName;
								return (
									<Link
										key={tagName}
										to="/vault/tag/$tagName"
										params={{ tagName: encodeURIComponent(tagName) }}
										className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
											isActive ? "bg-muted/60" : "hover:bg-muted/30"
										}`}
									>
										<Tag className="size-3.5 shrink-0" style={{ color }} />
										<span className="truncate">{tagName}</span>
									</Link>
								);
							})}
						</SidebarSection>
					</div>
				)}

				{/* Trash */}
				<Link
					to="/vault/trash"
					className={`mt-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors ${
						isTrashActive ? "bg-muted/60" : "hover:bg-muted/30"
					}`}
				>
					<Archive className="size-4 text-muted-foreground" />
					<span>Trash</span>
				</Link>
			</div>
		</div>
	);
}
