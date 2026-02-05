import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
	Separator,
} from "@bittery/ui";
import { useMemo } from "react";
import type { VaultOption } from "../../types";
import { VaultAvatar } from "../../vault-avatar";

interface VaultSelectorProps {
	vaults: VaultOption[];
	selectedVault?: VaultOption;
	onVaultChange: (vaultId: string) => void;
}

function getInitials(name: string): string {
	if (!name) return "??";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

export function VaultSelector({
	vaults,
	selectedVault,
	onVaultChange,
}: VaultSelectorProps) {
	// Group vaults by account
	const vaultGroups = useMemo(() => {
		const groups: Map<
			string,
			{
				accountKey: string;
				accountName: string;
				accountTeamName?: string;
				accountTeamAvatarUrl?: string | null;
				vaults: VaultOption[];
			}
		> = new Map();

		for (const vault of vaults) {
			const accountKey = vault.accountEmail || "default";
			const existingGroup = groups.get(accountKey);

			if (existingGroup) {
				existingGroup.vaults.push(vault);
			} else {
				groups.set(accountKey, {
					accountKey,
					accountName:
						vault.accountName ||
						vault.accountEmail?.split("@")[0] ||
						"Account",
					accountTeamName: vault.accountTeamName,
					accountTeamAvatarUrl: vault.accountTeamAvatarUrl,
					vaults: [vault],
				});
			}
		}

		return Array.from(groups.values());
	}, [vaults]);

	const hasMultipleAccounts = vaultGroups.length > 1;

	return (
		<Select value={selectedVault?.id} onValueChange={onVaultChange}>
			<SelectTrigger className="h-auto w-auto min-w-52 gap-3 py-1.5 [&>span]:line-clamp-none!">
				<SelectValue placeholder="Select vault">
					{selectedVault && (
						<div className="flex items-center gap-2">
							{(selectedVault.accountTeamName ||
								selectedVault.accountName) && (
								<>
									<Avatar className="h-5 w-5 text-[10px]">
										<AvatarImage
											src={selectedVault.accountTeamAvatarUrl ?? undefined}
											alt={
												selectedVault.accountTeamName ||
												selectedVault.accountName
											}
										/>
										<AvatarFallback className="text-[10px]">
											{getInitials(
												selectedVault.accountTeamName ||
													selectedVault.accountName ||
													"",
											)}
										</AvatarFallback>
									</Avatar>
									<Separator orientation="vertical" className="h-4" />
								</>
							)}
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
				{hasMultipleAccounts
					? vaultGroups.map((group, index) => (
							<div key={group.accountKey}>
								{index > 0 && <SelectSeparator />}
								<SelectGroup>
									<SelectLabel className="flex items-center gap-2">
										<Avatar className="h-4 w-4 text-[9px]">
											<AvatarImage
												src={group.accountTeamAvatarUrl ?? undefined}
												alt={group.accountTeamName || group.accountName}
											/>
											<AvatarFallback className="text-[9px]">
												{getInitials(
													group.accountTeamName || group.accountName,
												)}
											</AvatarFallback>
										</Avatar>
										<span>{group.accountTeamName || group.accountName}</span>
									</SelectLabel>
									{group.vaults.map((vault) => (
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
								</SelectGroup>
							</div>
						))
					: vaults.map((vault) => (
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
