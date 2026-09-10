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
			{/*
			  * `line-clamp-none` leaves the value span `overflow: visible`, so without `min-w-0` its
			  * automatic minimum size is the full vault name and a long one paints over the actions.
			  * `max-sm:` rules: full width on its own footer row, with a 44px tap target.
			  */}
			<SelectTrigger className="h-auto w-auto min-w-52 gap-3 py-1.5 [&>span]:line-clamp-none! [&>span]:min-w-0 max-sm:min-h-11 max-sm:w-full max-sm:min-w-0">
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
