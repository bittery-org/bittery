import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../../../select";
import type { VaultOption } from "../../types";
import { VaultAvatar } from "../../../vault-avatar";

interface VaultSelectorProps {
	vaults: VaultOption[];
	selectedVault?: VaultOption;
	onVaultChange: (vaultId: string) => void;
}

export function VaultSelector({
	vaults,
	selectedVault,
	onVaultChange,
}: VaultSelectorProps) {
	return (
		<Select value={selectedVault?.id} onValueChange={onVaultChange}>
			<SelectTrigger className="h-auto w-auto min-w-52 gap-3 py-1.5 [&>span]:line-clamp-none!">
				<SelectValue placeholder="Select vault">
					{selectedVault && (
						<div className="flex items-center gap-2">
							<VaultAvatar
								name={selectedVault.name}
								icon={selectedVault.icon}
								imageUrl={selectedVault.imageUrl}
								size="xs"
							/>
							<span className="truncate">{selectedVault.name}</span>
						</div>
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent>
				{vaults.map((vault) => (
					<SelectItem key={vault.id} value={vault.id}>
						<div className="flex items-center gap-2">
							<VaultAvatar
								name={vault.name}
								icon={vault.icon}
								imageUrl={vault.imageUrl}
								size="xs"
							/>
							<span>{vault.name}</span>
						</div>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
