import { Avatar, AvatarFallback, cn } from "@bittery/ui";
import type { AccountMetadata } from "@/lib/storage";

interface AccountAvatarProps {
	account: AccountMetadata | null;
	size?: "sm" | "md" | "lg";
	className?: string;
}

export function AccountAvatar({
	account,
	size = "md",
	className,
}: AccountAvatarProps) {
	const sizeClasses = {
		sm: "h-6 w-6 text-xs",
		md: "h-8 w-8 text-sm",
		lg: "h-10 w-10 text-base",
	};

	const initials = account?.teamName
		? account.teamName
				.split(" ")
				.map((n) => n[0])
				.join("")
				.toUpperCase()
				.slice(0, 2)
		: account?.name
			? account.name
					.split(" ")
					.map((n) => n[0])
					.join("")
					.toUpperCase()
					.slice(0, 2)
			: account?.email
				? account.email.substring(0, 2).toUpperCase()
				: "?";

	return (
		<Avatar className={cn(sizeClasses[size], className)}>
			<AvatarFallback className={sizeClasses[size]}>{initials}</AvatarFallback>
		</Avatar>
	);
}
