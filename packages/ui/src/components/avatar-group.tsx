/**
 * AvatarGroup component for displaying multiple avatars with overflow count
 * Used in "All Accounts" mode to show account avatars
 */

import { cn } from "../lib/utils";
import {
	Avatar,
	AvatarFallback,
	AvatarGroupCount,
	AvatarGroup as AvatarGroupRaw,
	AvatarImage,
} from "./avatar";

export interface AvatarGroupAccount {
	accountId: string;
	email: string;
	name?: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
}

export interface AvatarGroupProps {
	accounts: AvatarGroupAccount[];
	maxVisible?: number;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const sizeClasses = {
	sm: "h-6 w-6 text-xs",
	md: "h-8 w-8 text-sm",
	lg: "h-10 w-10 text-base",
};

function getInitials(account: AvatarGroupAccount): string {
	const name = account.teamName || account.name || account.email;
	return name
		.split(" ")
		.map((word) => word[0])
		.join("")
		.toUpperCase()
		.slice(0, 2);
}

export function AccountAvatarGroup({
	accounts,
	maxVisible = 2,
	size = "md",
	className,
}: AvatarGroupProps) {
	const visibleAccounts = accounts.slice(0, maxVisible);
	const overflowCount = accounts.length - maxVisible;

	return (
		<AvatarGroupRaw className={className}>
			{visibleAccounts.map((account) => (
				<Avatar key={account.accountId} className={cn(sizeClasses[size])}>
					{account.teamAvatarUrl && (
						<AvatarImage
							src={account.teamAvatarUrl}
							alt={account.teamName || account.name || account.email}
						/>
					)}
					<AvatarFallback>{getInitials(account)}</AvatarFallback>
				</Avatar>
			))}
			{overflowCount > 0 && (
				<AvatarGroupCount className={cn(sizeClasses[size])}>
					+{overflowCount}
				</AvatarGroupCount>
			)}
		</AvatarGroupRaw>
	);
}
