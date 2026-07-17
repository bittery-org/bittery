import { Avatar, AvatarFallback, AvatarImage, cn } from "@bittery/ui";
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
		sm: "size-5 rounded-[5px] text-[9px]",
		md: "size-8 rounded-md text-xs",
		lg: "size-10 rounded-lg text-sm",
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
			<AvatarImage
				src={account?.teamAvatarUrl ?? undefined}
				alt={account?.teamName || account?.name || account?.email}
			/>
			<AvatarFallback
				className={cn(
					sizeClasses[size],
					"bg-linear-to-br from-primary to-primary-deep font-semibold text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.15)]",
				)}
			>
				{initials}
			</AvatarFallback>
		</Avatar>
	);
}
