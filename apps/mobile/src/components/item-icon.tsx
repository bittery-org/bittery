import { getFaviconUrl, getItemFaviconUrl } from "@bittery/shared/favicon";
import type {
	DecryptedItemWithContext,
	ItemCategory,
} from "@bittery/shared/types";
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import {
	type AppIcon,
	GradientTile,
	IconCreditCard,
	IconFileText,
	IconKey,
	IconTimer,
	IconUser,
} from "@/components/ui";
import { useServerUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

const StyledImage = withUniwind(Image);

const categoryIcons: Record<ItemCategory, AppIcon> = {
	login: IconKey,
	"credit-card": IconCreditCard,
	identity: IconUser,
	"secure-note": IconFileText,
	totp: IconTimer,
};

interface ItemIconProps {
	item?: Pick<
		DecryptedItemWithContext,
		"url" | "category" | "serverUrl" | "account" | "title"
	>;
	category: ItemCategory;
	/** Hashed to pick the fallback gradient. Falls back to the URL, then the category. */
	title?: string;
	url?: string;
	serverUrl?: string;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const sizeMap = {
	sm: { tile: 32, radius: 9, glyph: 16, favicon: 32 as const },
	md: { tile: 40, radius: 12, glyph: 20, favicon: 32 as const },
	lg: { tile: 56, radius: 16, glyph: 26, favicon: 64 as const },
};

/**
 * Leading tile for an item row: the site favicon when we have a URL, otherwise
 * a deterministic gradient tile carrying the item category's glyph.
 */
export function ItemIcon({
	item,
	category,
	title,
	url,
	serverUrl,
	size = "md",
	className,
}: ItemIconProps) {
	const resolvedCategory = item?.category ?? category;
	const Icon = categoryIcons[resolvedCategory];
	const [faviconError, setFaviconError] = useState(false);
	const { serverUrl: contextServerUrl } = useServerUrl();

	const { tile, radius, glyph, favicon } = sizeMap[size];
	const resolvedServerUrl = serverUrl ?? contextServerUrl ?? undefined;

	const faviconUrl =
		resolvedCategory === "login" && !faviconError
			? item
				? getItemFaviconUrl(item, favicon, resolvedServerUrl)
				: url
					? getFaviconUrl(url, favicon, resolvedServerUrl)
					: null
			: null;

	if (faviconUrl) {
		return (
			<View
				className={cn(
					"items-center justify-center overflow-hidden border border-border bg-surface-secondary",
					className,
				)}
				style={{ width: tile, height: tile, borderRadius: radius }}
			>
				<StyledImage
					source={{ uri: faviconUrl }}
					className="h-full w-full"
					contentFit="contain"
					cachePolicy="memory-disk"
					onError={() => setFaviconError(true)}
				/>
			</View>
		);
	}

	const gradientName = title ?? item?.title ?? item?.url ?? url ?? category;

	return (
		<GradientTile
			name={gradientName}
			size={tile}
			radius={radius}
			className={className}
		>
			<Icon size={glyph} className="text-white" />
		</GradientTile>
	);
}
