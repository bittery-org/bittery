import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Separator,
	VaultAvatar,
} from "@bittery/ui";
import { IconChevronDownOutlineDuo18 } from "@bittery/ui/icons";

interface VaultInfoPopoverProps {
	vaultName: string;
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	vaultType?: "personal" | "team";
	accountName?: string;
	accountTeamName?: string;
	accountTeamAvatarUrl?: string | null;
	children?: React.ReactNode;
}

function getInitials(name: string): string {
	if (!name) return "??";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

export function VaultInfoPopover({
	vaultName,
	vaultIcon,
	vaultImageUrl,
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
					{displayTeamName && (
						<>
							<Avatar className="size-5 shrink-0 text-[10px]">
								<AvatarImage
									src={accountTeamAvatarUrl ?? undefined}
									alt={displayTeamName}
								/>
								<AvatarFallback className="text-[10px]">
									{getInitials(displayTeamName)}
								</AvatarFallback>
							</Avatar>
							<span className="hidden min-w-0 max-w-32 shrink truncate text-sm lg:block">
								{displayTeamName}
							</span>
							<Separator orientation="vertical" className="mx-1" />
						</>
					)}
					<VaultAvatar
						name={vaultName}
						icon={vaultIcon}
						imageUrl={vaultImageUrl}
						size="xs"
						className="shrink-0 border-none bg-transparent"
					/>
					<span className="mr-0.5 shrink text-sm">{vaultName}</span>
					<IconChevronDownOutlineDuo18 className="size-3.5 shrink-0 opacity-50" />
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
								<p className="truncate text-muted-foreground text-xs">
									{displayTeamName}
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
