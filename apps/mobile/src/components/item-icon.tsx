import { getFaviconUrl, getItemFaviconUrl } from "@bittery/shared/favicon";
import type {
	DecryptedItemWithContext,
	ItemCategory,
} from "@bittery/shared/types";
import { Image } from "expo-image";
import { CreditCard, FileText, Key, Timer, User } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { useServerUrl } from "@/lib/rpc";
import { cn } from "@/lib/utils";

// Create styled icon components
const StyledKey = withUniwind(Key);
const StyledCreditCard = withUniwind(CreditCard);
const StyledUser = withUniwind(User);
const StyledFileText = withUniwind(FileText);
const StyledTimer = withUniwind(Timer);
const StyledImage = withUniwind(Image);

const categoryIcons: Record<
	ItemCategory,
	| typeof StyledKey
	| typeof StyledCreditCard
	| typeof StyledUser
	| typeof StyledFileText
	| typeof StyledTimer
> = {
	login: StyledKey,
	"credit-card": StyledCreditCard,
	identity: StyledUser,
	"secure-note": StyledFileText,
	totp: StyledTimer,
};

interface ItemIconProps {
	item?: Pick<
		DecryptedItemWithContext,
		"url" | "category" | "serverUrl" | "account"
	>;
	category: ItemCategory;
	url?: string;
	serverUrl?: string;
	/** Size of the container (default: 32px for 8 Tailwind units) */
	size?: "sm" | "md" | "lg";
	/** Custom className for the container */
	className?: string;
}

const sizeMap = {
	sm: { container: "h-8 w-8", icon: 16, favicon: 32 as const },
	md: { container: "h-10 w-10", icon: 20, favicon: 32 as const },
	lg: { container: "h-12 w-12", icon: 24, favicon: 64 as const },
};

export function ItemIcon({
	item,
	category,
	url,
	serverUrl,
	size = "sm",
	className,
}: ItemIconProps) {
	const resolvedCategory = item?.category ?? category;
	const Icon = categoryIcons[resolvedCategory];
	const [faviconError, setFaviconError] = useState(false);
	const { serverUrl: contextServerUrl } = useServerUrl();

	// Get favicon URL for login items with a URL
	const faviconUrl =
		resolvedCategory === "login" && !faviconError
			? item
				? getItemFaviconUrl(
						item,
						sizeMap[size].favicon,
						serverUrl ?? contextServerUrl ?? undefined,
					)
				: url
					? getFaviconUrl(
							url,
							sizeMap[size].favicon,
							serverUrl ?? contextServerUrl ?? undefined,
						)
					: null
			: null;

	const { container, icon } = sizeMap[size];

	return (
		<View
			className={cn(
				"items-center",
				"justify-center",
				"overflow-hidden",
				"rounded-lg",
				"bg-surface-secondary",
				container,
				className || "",
			)}
		>
			{faviconUrl ? (
				<StyledImage
					source={{ uri: faviconUrl }}
					className="h-full w-full"
					contentFit="contain"
					cachePolicy="memory-disk"
					onError={() => setFaviconError(true)}
				/>
			) : (
				<Icon size={icon} className="text-muted" />
			)}
		</View>
	);
}
