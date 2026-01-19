import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@bittery/ui";
import { Link } from "@tanstack/react-router";
import { FileUp, MoreHorizontal, Pencil, PlusIcon, Trash2 } from "lucide-react";
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
	currentVaultId?: string;
	onNewVault: () => void;
	onEditVault: (vault: { id: string; name: string }) => void;
	onDeleteVault: (vault: { id: string; name: string }) => void;
	onImportItems?: (vaultId: string) => void;
}

export function VaultSidebar({
	vaults,
	currentVaultId,
	onNewVault,
	onEditVault,
	onDeleteVault,
	onImportItems,
}: VaultSidebarProps) {
	return (
		<div className="flex w-48 flex-col border-r bg-background">
			<div className="flex flex-1 flex-col overflow-y-auto p-2">
				{vaults.map((vault) => (
					<div
						key={vault.vaultId}
						className={`group relative mb-1 w-full rounded-md text-left text-sm transition-colors ${
							currentVaultId === vault.vaultId
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
									size="sm"
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
										className="-translate-y-1/2 absolute top-1/2 right-1 h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
										onClick={(e) => e.stopPropagation()}
									>
										<MoreHorizontal className="h-4 w-4" />
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
			</div>
			<div className="border-t p-2">
				<Button
					onClick={onNewVault}
					variant="outline"
					className="w-full"
					size="sm"
				>
					<PlusIcon className="mr-2 h-4 w-4" />
					New Vault
				</Button>
			</div>
		</div>
	);
}
