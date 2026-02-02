import type {
	ItemCategory,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import { getFaviconUrl } from "@bittery/shared/favicon";
import { Card, PressableFeedback } from "heroui-native";
import {
	CreditCard,
	FileText,
	Key,
	Star,
	Timer,
	User,
} from "lucide-react-native";
import { useState } from "react";
import { Image, View } from "react-native";
import { withUniwind } from "uniwind";

import { TotpDisplay } from "./totp-display";

// Create styled icon components
const StyledKey = withUniwind(Key);
const StyledCreditCard = withUniwind(CreditCard);
const StyledUser = withUniwind(User);
const StyledFileText = withUniwind(FileText);
const StyledTimer = withUniwind(Timer);
const StyledStar = withUniwind(Star);

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

interface ItemListItemProps {
	id: string;
	title: string;
	category: ItemCategory;
	favorite?: boolean;
	username?: string;
	url?: string;
	vault?: {
		id: string;
		name: string;
		type: string;
	};
	showVaultBadge?: boolean;
	onPress: () => void;
	rightContent?: React.ReactNode;
	/** TOTP fields for showing live codes in list */
	totpSecret?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
	/** Whether to show inline TOTP code (for TOTP category items or login items with TOTP) */
	showInlineTotp?: boolean;
	/** Position in the list for rounded corners */
	isFirstInSection?: boolean;
	isLastInSection?: boolean;
}

export function ItemListItem({
	id: _id,
	title,
	category,
	favorite,
	username,
	url,
	vault: _vault,
	showVaultBadge: _showVaultBadge = false,
	onPress,
	rightContent,
	totpSecret,
	totpAlgorithm,
	totpDigits,
	totpPeriod,
	showInlineTotp = false,
	isFirstInSection = false,
	isLastInSection = false,
}: ItemListItemProps) {
	const Icon = categoryIcons[category];
	const [faviconError, setFaviconError] = useState(false);

	// Show TOTP if item has TOTP secret and showInlineTotp is enabled
	const shouldShowTotp = showInlineTotp && totpSecret;

	// Get favicon URL for login items with a URL
	const faviconUrl =
		category === "login" && url && !faviconError
			? getFaviconUrl(url, 32)
			: null;

	// Get subtitle based on category
	const getSubtitle = () => {
		// If showing inline TOTP, don't show subtitle text for TOTP items
		if (shouldShowTotp && category === "totp") return null;
		if (category === "login" && username) return username;
		if (category === "login" && url) return url;
		if (category === "credit-card") return "Credit Card";
		if (category === "identity") return "Identity";
		if (category === "secure-note") return "Secure Note";
		if (category === "totp") return "TOTP";
		return null;
	};

	const subtitle = getSubtitle();

	// Determine rounded corners based on position
	const getCardRounding = () => {
		if (isFirstInSection && isLastInSection) {
			return "rounded-2xl"; // Single item
		}
		if (isFirstInSection) {
			return "rounded-t-2xl rounded-b-md"; // First item
		}
		if (isLastInSection) {
			return "rounded-t-md rounded-b-2xl"; // Last item
		}
		return "rounded-md"; // Middle item
	};

	return (
		<PressableFeedback onPress={onPress} className="mx-4 mb-1">
			<Card className={getCardRounding()}>
				<PressableFeedback.Ripple />
				<Card.Body className="flex-row items-center pl-1.5 pr-3 py-1">
					{/* Icon or Favicon */}
					<View className="mr-3.5 h-8 w-8 items-center justify-center overflow-hidden rounded-lg bg-surface-secondary">
						{faviconUrl ? (
							<Image
								source={{ uri: faviconUrl }}
								className="h-full w-full"
								resizeMode="contain"
								onError={() => setFaviconError(true)}
							/>
						) : (
							<Icon size={16} className="text-muted" />
						)}
					</View>

					{/* Content */}
					<View className="min-w-0 flex-1">
						<View className="flex-row items-center">
							<Card.Title className="flex-shrink text-base" numberOfLines={1}>
								{title}
							</Card.Title>
							{favorite && (
								<StyledStar
									size={12}
									fill="#eab308"
									className="ml-1.5 text-yellow-500"
								/>
							)}
						</View>
						{subtitle && (
							<Card.Description className="text-xs" numberOfLines={1}>
								{subtitle}
							</Card.Description>
						)}
						{/* Inline TOTP display for TOTP items or login items with TOTP */}
						{shouldShowTotp && (
							<View className="mt-0.5">
								<TotpDisplay
									totpSecret={totpSecret}
									totpAlgorithm={totpAlgorithm}
									totpDigits={totpDigits}
									totpPeriod={totpPeriod}
									inline
								/>
							</View>
						)}
					</View>

					{/* Right content (optional, e.g., for swipe actions indicator) */}
					{rightContent && <View className="ml-2">{rightContent}</View>}
				</Card.Body>
			</Card>
		</PressableFeedback>
	);
}
