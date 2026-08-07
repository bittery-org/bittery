import { useState } from "react";
import { Image, Text, View } from "react-native";
import {
	type AppIcon,
	GradientTile,
	IconBriefcase,
	IconFolderClosed,
	IconHeart,
	IconKey,
	IconLock,
	IconShield,
	IconStar,
	IconUsers,
} from "@/components/ui";
import { cn } from "@/lib/utils";

type VaultIconName =
	| "lock"
	| "shield"
	| "users"
	| "briefcase"
	| "key"
	| "folder"
	| "star"
	| "heart";

const vaultIconMap: Record<VaultIconName, AppIcon> = {
	lock: IconLock,
	shield: IconShield,
	users: IconUsers,
	briefcase: IconBriefcase,
	key: IconKey,
	folder: IconFolderClosed,
	star: IconStar,
	heart: IconHeart,
};

interface VaultAvatarProps {
	name: string;
	icon?: string | null;
	imageUrl?: string | null;
	size?: "xs" | "sm" | "md" | "lg";
	className?: string;
}

const sizeMap = {
	xs: { tile: 24, radius: 7, glyph: 13, text: "text-2xs" },
	sm: { tile: 32, radius: 9, glyph: 16, text: "text-xs" },
	md: { tile: 40, radius: 12, glyph: 20, text: "text-sm" },
	lg: { tile: 48, radius: 14, glyph: 24, text: "text-base" },
} as const;

function getInitials(name: string): string {
	if (!name) return "?";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

/** Vault identity tile: uploaded image, chosen glyph, or hashed-gradient initials. */
export function VaultAvatar({
	name,
	icon,
	imageUrl,
	size = "md",
	className,
}: VaultAvatarProps) {
	const [imageError, setImageError] = useState(false);
	const { tile, radius, glyph, text } = sizeMap[size];
	const Icon = icon ? vaultIconMap[icon as VaultIconName] : undefined;

	if (imageUrl && !imageError) {
		return (
			<View
				className={cn(
					"shrink-0 items-center justify-center overflow-hidden border border-border bg-surface-secondary",
					className,
				)}
				style={{ width: tile, height: tile, borderRadius: radius }}
			>
				<Image
					source={{ uri: imageUrl }}
					style={{ width: tile, height: tile }}
					resizeMode="cover"
					onError={() => setImageError(true)}
				/>
			</View>
		);
	}

	return (
		<GradientTile
			name={name || "Vault"}
			size={tile}
			radius={radius}
			className={cn("shrink-0", className)}
		>
			{Icon ? (
				<Icon size={glyph} className="text-white" />
			) : (
				<Text className={cn("font-semibold text-white", text)}>
					{getInitials(name)}
				</Text>
			)}
		</GradientTile>
	);
}
