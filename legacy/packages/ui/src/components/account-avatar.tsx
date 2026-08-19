import { cn, getAccountInitials, getAccountLabel } from "../lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";

/**
 * Structurally typed so every surface (switcher, dialogs, move targets) can pass
 * whatever account shape it holds without importing a runtime account type.
 */
export interface AccountAvatarAccount {
	email: string;
	name?: string | null;
	teamName?: string | null;
	teamAvatarUrl?: string | null;
}

export interface AccountAvatarProps {
	account: AccountAvatarAccount | null | undefined;
	size?: "xs" | "sm" | "md" | "lg";
	className?: string;
}

const sizeClasses = {
	xs: "size-5 rounded-[5px] text-[9px]",
	sm: "size-6 rounded-md text-[10px]",
	md: "size-8 rounded-md text-xs",
	lg: "size-10 rounded-lg text-sm",
};

const fallbackClassName =
	"bg-linear-to-br from-primary to-primary-deep font-semibold text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.15)]";

/**
 * The one account avatar: team image when there is one, gradient initials when
 * there is not. Every account surface uses it so they cannot drift apart.
 */
export function AccountAvatar({
	account,
	size = "md",
	className,
}: AccountAvatarProps) {
	return (
		<Avatar className={cn(sizeClasses[size], className)}>
			{account?.teamAvatarUrl && (
				<AvatarImage
					src={account.teamAvatarUrl}
					alt={getAccountLabel(account)}
					className={sizeClasses[size]}
				/>
			)}
			<AvatarFallback className={cn(sizeClasses[size], fallbackClassName)}>
				{account ? getAccountInitials(account) : "?"}
			</AvatarFallback>
		</Avatar>
	);
}
