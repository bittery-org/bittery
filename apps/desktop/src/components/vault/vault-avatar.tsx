import { cn } from "@bittery/ui";
import {
	IconCarSideOutlineDuo18,
	IconFolderOutlineDuo18,
	IconHeartOutlineDuo18,
	IconKeyOutlineDuo18,
	IconLockOutlineDuo18,
	IconMagicShieldOutlineDuo18,
	IconMoneyDollarOutlineDuo18,
	IconMusicOutlineDuo18,
	IconPiggyBankOutlineDuo18,
	IconPlaneOutlineDuo18,
	IconSquareTerminalOutlineDuo18,
	IconStarSparkle2OutlineDuo18,
	IconSuitcase3OutlineDuo18,
	IconUsers6OutlineDuo18,
} from "@bittery/ui/icons";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

type VaultIconName =
	| "lock"
	| "shield"
	| "users"
	| "briefcase"
	| "key"
	| "folder"
	| "star"
	| "car"
	| "piggy_bank"
	| "money_dollar"
	| "music"
	| "plane"
	| "square_terminal"
	| "heart";

const vaultIconMap: Record<
	VaultIconName,
	LucideIcon | typeof IconLockOutlineDuo18
> = {
	lock: IconLockOutlineDuo18,
	shield: IconMagicShieldOutlineDuo18,
	users: IconUsers6OutlineDuo18,
	briefcase: IconSuitcase3OutlineDuo18,
	key: IconKeyOutlineDuo18,
	folder: IconFolderOutlineDuo18,
	star: IconStarSparkle2OutlineDuo18,
	heart: IconHeartOutlineDuo18,
	car: IconCarSideOutlineDuo18,
	piggy_bank: IconPiggyBankOutlineDuo18,
	money_dollar: IconMoneyDollarOutlineDuo18,
	music: IconMusicOutlineDuo18,
	plane: IconPlaneOutlineDuo18,
	square_terminal: IconSquareTerminalOutlineDuo18,
};

export const vaultIconOptions: Array<{
	value: VaultIconName;
	label: string;
	Icon: LucideIcon | typeof IconLockOutlineDuo18;
}> = [
	{ value: "lock", label: "Lock", Icon: IconLockOutlineDuo18 },
	{ value: "shield", label: "Shield", Icon: IconMagicShieldOutlineDuo18 },
	{ value: "users", label: "Users", Icon: IconUsers6OutlineDuo18 },
	{ value: "briefcase", label: "Briefcase", Icon: IconSuitcase3OutlineDuo18 },
	{ value: "key", label: "Key", Icon: IconKeyOutlineDuo18 },
	{ value: "folder", label: "Folder", Icon: IconFolderOutlineDuo18 },
	{ value: "star", label: "Star", Icon: IconStarSparkle2OutlineDuo18 },
	{ value: "heart", label: "Heart", Icon: IconHeartOutlineDuo18 },
	{ value: "car", label: "Car", Icon: IconCarSideOutlineDuo18 },
	{ value: "piggy_bank", label: "Piggy Bank", Icon: IconPiggyBankOutlineDuo18 },
	{
		value: "money_dollar",
		label: "Money Dollar",
		Icon: IconMoneyDollarOutlineDuo18,
	},
	{ value: "music", label: "Music", Icon: IconMusicOutlineDuo18 },
	{ value: "plane", label: "Plane", Icon: IconPlaneOutlineDuo18 },
	{
		value: "square_terminal",
		label: "Terminal",
		Icon: IconSquareTerminalOutlineDuo18,
	},
];

interface VaultAvatarProps {
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
	size?: "xs" | "sm" | "md" | "lg" | "xl";
	className?: string;
}

function getInitials(name: string): string {
	if (!name) return "??";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

function getAvatarColor(name: string): string {
	const colors = [
		"bg-red-500",
		"bg-orange-500",
		"bg-amber-500",
		"bg-yellow-500",
		"bg-lime-500",
		"bg-green-500",
		"bg-emerald-500",
		"bg-teal-500",
		"bg-cyan-500",
		"bg-sky-500",
		"bg-blue-500",
		"bg-indigo-500",
		"bg-violet-500",
		"bg-purple-500",
		"bg-fuchsia-500",
		"bg-pink-500",
		"bg-rose-500",
	];

	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		hash = name.charCodeAt(i) + ((hash << 5) - hash);
	}

	return colors[Math.abs(hash) % colors.length] ?? "bg-gray-500";
}

export function VaultAvatar({
	name,
	icon,
	imageUrl,
	size = "md",
	className,
}: VaultAvatarProps) {
	const [erroredImageUrl, setErroredImageUrl] = useState<string | null>(null);

	const sizeClasses = {
		xs: "h-6 w-6 text-[12px]",
		sm: "h-8 w-8 text-xs",
		md: "h-10 w-10 text-sm",
		lg: "h-12 w-12 text-base",
		xl: "h-20 w-20 text-2xl",
	};

	const iconSizes = {
		xs: 14.25,
		sm: 16,
		md: 20,
		lg: 24,
		xl: 40,
	};

	const Icon = icon ? vaultIconMap[icon as VaultIconName] : undefined;
	const showImage = Boolean(imageUrl && erroredImageUrl !== imageUrl);
	const showIcon = Boolean(!showImage && Icon);
	const initials = getInitials(name);
	const avatarColor = getAvatarColor(name || "Vault");

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center overflow-hidden rounded-md border",
				sizeClasses[size],
				showImage || showIcon ? "bg-muted/40" : avatarColor,
				className,
			)}
		>
			{showImage ? (
				<img
					src={imageUrl ?? ""}
					alt=""
					className="h-full w-full object-cover"
					onError={() => setErroredImageUrl(imageUrl ?? null)}
				/>
			) : showIcon && Icon ? (
				<Icon className="text-muted-foreground" size={iconSizes[size]} />
			) : (
				<span className="select-none font-semibold text-white">{initials}</span>
			)}
		</div>
	);
}
