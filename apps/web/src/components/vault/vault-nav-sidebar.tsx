import {
	Button,
	cn,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	getTagColorFromName,
} from "@bittery/ui";
import {
	IconBoxArchive3OutlineDuo18 as Archive,
	IconDotsOutlineDuo18 as Dots,
	IconGrid2OutlineDuo18 as Grid,
	IconPen2OutlineDuo18 as Pen,
	IconStarOutlineDuo18 as Star,
	IconTagOutlineDuo18 as Tag,
	IconTrash2OutlineDuo18 as Trash,
} from "@bittery/ui/icons";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { VaultAvatar } from "@/components/vaults/vault-avatar";
import { useI18n } from "@/providers/i18n-provider";
import { SidebarSection } from "./sidebar-section";

interface VaultInfo {
	vaultId: string;
	vaultName: string;
	vaultType: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	role: string;
}

interface VaultNavSidebarProps {
	vaults: VaultInfo[];
	tags: string[];
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
}

export function VaultNavSidebar({
	vaults,
	tags,
	currentVaultId,
	onNewVault,
	onEditVault,
	onDeleteVault,
	onNavigate,
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
			"mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
			active ? "bg-primary/10" : "hover:bg-muted/30",
		);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex-1 overflow-y-auto p-2">
				{/* All Objects */}
				<Link
					to="/vaults"
					className={navLinkClass(isAllItemsActive)}
					onClick={onNavigate}
				>
					<Grid className="size-4 text-muted-foreground" />
					<span>{m.vaults_sidebar_link_all_objects()}</span>
				</Link>

				{/* Favorites */}
				<Link
					to="/vaults/favorites"
					className={navLinkClass(isFavoritesActive)}
					onClick={onNavigate}
				>
					<Star className="size-4 text-yellow-500" fill="currentColor" />
					<span>{m.vaults_favorites_title()}</span>
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
							const canEdit = vault.role === "owner" || vault.role === "admin";
							const canDelete = vault.role === "owner";

							return (
								<div
									key={vault.vaultId}
									className={cn(
										"group relative mb-0.5 w-full rounded-md text-left text-sm transition-colors",
										isActive ? "bg-primary/10" : "hover:bg-muted/30",
									)}
								>
									<Link
										to="/vaults/$vaultId"
										params={{ vaultId: vault.vaultId }}
										className="block px-3 py-2"
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
									</Link>
									{(canEdit || canDelete) && (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="sm"
													className="absolute top-1/2 right-1 h-5 w-5 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100"
													onClick={(e) => e.stopPropagation()}
												>
													<Dots className="h-3.5 w-3.5" />
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
										className={cn(
											"mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
											isActive ? "bg-primary/10" : "hover:bg-muted/30",
										)}
										onClick={onNavigate}
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
					to="/vaults/trash"
					className={cn(navLinkClass(isTrashActive), "mt-2")}
					onClick={onNavigate}
				>
					<Archive className="size-4 text-muted-foreground" />
					<span>{m.vaults_sidebar_link_archive()}</span>
				</Link>
			</div>
		</div>
	);
}
