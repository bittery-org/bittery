/**
 * AvatarGroup component for displaying multiple avatars with overflow count
 * Used in "All Accounts" mode to show account avatars
 */

import { cn } from "../lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

export interface AvatarGroupAccount {
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

function getAvatarColor(email: string): string {
	// Simple hash function to generate consistent colors per email
	let hash = 0;
	for (let i = 0; i < email.length; i++) {
		hash = email.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = hash % 360;
	return `hsl(${hue}, 70%, 50%)`;
}

export function AvatarGroup({
	accounts,
	maxVisible = 2,
	size = "md",
	className,
}: AvatarGroupProps) {
	const visibleAccounts = accounts.slice(0, maxVisible);
	const overflowCount = accounts.length - maxVisible;

	return (
		<div className={cn("flex -space-x-2", className)}>
			{visibleAccounts.map((account, index) => (
				<Avatar
					key={account.email}
					className={cn(
						sizeClasses[size],
						"border-1 border-background ring-2 ring-background",
					)}
					style={{ zIndex: visibleAccounts.length - index }}
				>
					{account.teamAvatarUrl && (
						<AvatarImage
							src={account.teamAvatarUrl}
							alt={account.teamName || account.name || account.email}
						/>
					)}
					<AvatarFallback
						className="text-white font-medium"
						style={{ backgroundColor: getAvatarColor(account.email) }}
					>
						{getInitials(account)}
					</AvatarFallback>
				</Avatar>
			))}
			{overflowCount > 0 && (
				<Avatar
					className={cn(
						sizeClasses[size],
						"border-2 border-background ring-2 ring-background",
					)}
					style={{ zIndex: 0 }}
				>
					<AvatarFallback className="bg-muted text-muted-foreground font-medium">
						+{overflowCount}
					</AvatarFallback>
				</Avatar>
			)}
		</div>
	);
}
