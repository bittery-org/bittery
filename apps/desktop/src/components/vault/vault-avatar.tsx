import { cn } from "@bittery/ui";
import type { LucideIcon } from "lucide-react";
import {
	Briefcase,
	FolderClosed,
	Heart,
	Key,
	Lock,
	Shield,
	Star,
	Users,
} from "lucide-react";
import { useEffect, useState } from "react";

type VaultIconName =
	| "lock"
	| "shield"
	| "users"
	| "briefcase"
	| "key"
	| "folder"
	| "star"
	| "heart";

const vaultIconMap: Record<VaultIconName, LucideIcon> = {
	lock: Lock,
	shield: Shield,
	users: Users,
	briefcase: Briefcase,
	key: Key,
	folder: FolderClosed,
	star: Star,
	heart: Heart,
};

export const vaultIconOptions: Array<{
	value: VaultIconName;
	label: string;
	Icon: LucideIcon;
}> = [
	{ value: "lock", label: "Lock", Icon: Lock },
	{ value: "shield", label: "Shield", Icon: Shield },
	{ value: "users", label: "Users", Icon: Users },
	{ value: "briefcase", label: "Briefcase", Icon: Briefcase },
	{ value: "key", label: "Key", Icon: Key },
	{ value: "folder", label: "Folder", Icon: FolderClosed },
	{ value: "star", label: "Star", Icon: Star },
	{ value: "heart", label: "Heart", Icon: Heart },
];

interface VaultAvatarProps {
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
	size?: "sm" | "md" | "lg";
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
	const [imageError, setImageError] = useState(false);

	useEffect(() => {
		setImageError(false);
	}, []);

	const sizeClasses = {
		sm: "h-8 w-8 text-xs",
		md: "h-10 w-10 text-sm",
		lg: "h-12 w-12 text-base",
	};

	const iconSizes = {
		sm: 16,
		md: 20,
		lg: 24,
	};

	const Icon = icon ? vaultIconMap[icon as VaultIconName] : undefined;
	const showImage = Boolean(imageUrl && !imageError);
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
					onError={() => setImageError(true)}
				/>
			) : showIcon && Icon ? (
				<Icon className="text-muted-foreground" size={iconSizes[size]} />
			) : (
				<span className="select-none font-semibold text-white">{initials}</span>
			)}
		</div>
	);
}
