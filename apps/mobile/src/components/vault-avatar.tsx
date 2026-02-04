import { Card } from "heroui-native";
import {
	Briefcase,
	FolderClosed,
	Heart,
	Key,
	Lock,
	Shield,
	Star,
	Users,
} from "lucide-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { withUniwind } from "uniwind";

type VaultIconName =
	| "lock"
	| "shield"
	| "users"
	| "briefcase"
	| "key"
	| "folder"
	| "star"
	| "heart";

const StyledLock = withUniwind(Lock);
const StyledShield = withUniwind(Shield);
const StyledUsers = withUniwind(Users);
const StyledBriefcase = withUniwind(Briefcase);
const StyledKey = withUniwind(Key);
const StyledFolderClosed = withUniwind(FolderClosed);
const StyledStar = withUniwind(Star);
const StyledHeart = withUniwind(Heart);

const vaultIconMap: Record<VaultIconName, typeof StyledLock> = {
	lock: StyledLock,
	shield: StyledShield,
	users: StyledUsers,
	briefcase: StyledBriefcase,
	key: StyledKey,
	folder: StyledFolderClosed,
	star: StyledStar,
	heart: StyledHeart,
};

interface VaultAvatarProps {
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
	size?: "xs" | "sm" | "md" | "lg";
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

	const sizeClasses = {
		xs: "h-6 w-6",
		sm: "h-8 w-8",
		md: "h-10 w-10",
		lg: "h-12 w-12",
	};

	const iconSizes = {
		xs: 13,
		sm: 16,
		md: 20,
		lg: 24,
	};

	const textSizes = {
		xs: "text-[10px]",
		sm: "text-xs",
		md: "text-sm",
		lg: "text-base",
	};

	const Icon = icon ? vaultIconMap[icon as VaultIconName] : undefined;
	const showImage = Boolean(imageUrl && !imageError);
	const showIcon = Boolean(!showImage && Icon);
	const initials = getInitials(name);
	const avatarColor = getAvatarColor(name || "Vault");

	return (
		<View
			className={`flex shrink-0 items-center justify-center overflow-hidden rounded-lg ${
				sizeClasses[size]
			} ${showImage || showIcon ? "bg-surface-secondary" : avatarColor} ${
				className || ""
			}`}
		>
			{showImage ? (
				<Image
					source={{ uri: imageUrl ?? "" }}
					className="h-full w-full"
					resizeMode="cover"
					onError={() => setImageError(true)}
				/>
			) : showIcon && Icon ? (
				<Icon size={iconSizes[size]} className="text-muted" />
			) : (
				<Card.Title
					className={`select-none font-semibold text-white ${textSizes[size]}`}
				>
					{initials}
				</Card.Title>
			)}
		</View>
	);
}
