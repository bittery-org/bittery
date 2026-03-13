import { getFaviconUrl } from "@bittery/shared/favicon";
import type { ItemCategory } from "@bittery/shared/types";
import { CreditCard, FileText, Key, Timer, User } from "lucide-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/utils";
import { useServerUrl } from "@/lib/trpc";

// Create styled icon components
const StyledKey = withUniwind(Key);
const StyledCreditCard = withUniwind(CreditCard);
const StyledUser = withUniwind(User);
const StyledFileText = withUniwind(FileText);
const StyledTimer = withUniwind(Timer);

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
	category: ItemCategory;
	url?: string;
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
	category,
	url,
	size = "sm",
	className,
}: ItemIconProps) {
	const Icon = categoryIcons[category];
	const [faviconError, setFaviconError] = useState(false);
	const { serverUrl } = useServerUrl();

	// Get favicon URL for login items with a URL
	const faviconUrl =
		category === "login" && url && !faviconError
			? getFaviconUrl(url, sizeMap[size].favicon, serverUrl ?? undefined)
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
				<Image
					source={{ uri: faviconUrl }}
					className="h-full w-full"
					resizeMode="contain"
					onError={() => setFaviconError(true)}
				/>
			) : (
				<Icon size={icon} className="text-muted" />
			)}
		</View>
	);
}
