import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bittery/ui";
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
          <SidebarSection
            title="Vaults"
            storageKey="vaults"
            defaultOpen={true}
            onAdd={onNewVault}
          >
            {vaults.map((vault) => (
              <div
                key={vault.vaultId}
                className={`group relative mb-0.5 w-full rounded-md text-left text-sm transition-colors ${
                  currentVaultId === vault.vaultId &&
                  !isAllItemsActive &&
                  !isFavoritesActive &&
                  !isTrashActive &&
                  !isTagActive
                    ? "bg-muted/60"
                    : "hover:bg-muted/30"
                }`}
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
                        className="-translate-y-1/2 absolute top-1/2 right-1 h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
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
                        <DropdownMenuItem
                          onClick={() => onImportItems(vault.vaultId)}
                        >
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
            ))}
          </SidebarSection>
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
