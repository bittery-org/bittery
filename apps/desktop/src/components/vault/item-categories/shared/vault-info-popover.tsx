import {
	AccountAvatar,
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Separator,
	VaultAvatar,
} from "@bittery/ui";
import { IconChevronDown } from "@bittery/ui/icons";

interface VaultInfoPopoverProps {
	vaultName: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	accountEmail?: string;
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
	children?: React.ReactNode;
}

export function VaultInfoPopover({
	vaultName,
	vaultIcon,
	vaultImageUrl,
	accountEmail,
	accountName,
	accountTeamName,
	accountTeamAvatarUrl,
	children,
}: VaultInfoPopoverProps) {
	const displayTeamName = accountTeamName || accountName;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="min-w-0 max-w-full gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground"
				>
					<VaultAvatar
						name={vaultName}
						icon={vaultIcon}
						imageUrl={vaultImageUrl}
						size="xs"
						className="shrink-0 border-none bg-transparent"
					/>
					<span className="mr-0.5 shrink text-sm">{vaultName}</span>
					<IconChevronDown className="size-3.5 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-0">
				<div className="p-3">
					<div className="flex items-center gap-3">
						<VaultAvatar
							name={vaultName}
							icon={vaultIcon}
							imageUrl={vaultImageUrl}
							size="sm"
						/>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-sm">{vaultName}</p>
							{displayTeamName && (
								<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
									<AccountAvatar
										account={{
											email: accountEmail ?? "",
											name: accountName,
											teamName: accountTeamName,
											teamAvatarUrl: accountTeamAvatarUrl,
										}}
										size="xs"
										className="size-4 rounded-[4px] text-[8px]"
									/>
									<span className="truncate">{displayTeamName}</span>
								</p>
							)}
						</div>
					</div>
				</div>
				{children && (
					<>
						<Separator />
						<div className="p-1">{children}</div>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
