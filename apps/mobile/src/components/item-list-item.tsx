import type {
	DecryptedItemWithContext,
	TotpAlgorithm,
	TotpDigits,
} from "@bittery/shared/types";
import { Card, PressableFeedback } from "heroui-native";
import { Star } from "lucide-react-native";
import { View } from "react-native";
import { withUniwind } from "uniwind";

import { ItemIcon } from "./item-icon";
import { TotpDisplay } from "./totp-display";

// Create styled icon components
const StyledStar = withUniwind(Star);

interface ItemListItemProps {
	item: DecryptedItemWithContext;
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
	item,
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
	// Show TOTP if item has TOTP secret and showInlineTotp is enabled
	const shouldShowTotp = showInlineTotp && totpSecret;

	// Get subtitle based on category
	const getSubtitle = () => {
		// If showing inline TOTP, don't show subtitle text for TOTP items
		if (shouldShowTotp && item.category === "totp") return null;
		if (item.category === "login" && item.username) return item.username;
		if (item.category === "login" && item.url) return item.url;
		if (item.category === "credit-card") return "Credit Card";
		if (item.category === "identity") return "Identity";
		if (item.category === "secure-note") return "Secure Note";
		if (item.category === "totp") return "TOTP";
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
				<Card.Body className="flex-row items-center py-1 pr-3 pl-1.5">
					{/* Icon or Favicon */}
					<ItemIcon item={item} category={item.category} size="sm" className="mr-3.5" />

					{/* Content */}
					<View className="min-w-0 flex-1">
						<View className="flex-row items-center">
							<Card.Title className="shrink text-base" numberOfLines={1}>
								{item.title}
							</Card.Title>
							{item.favorite && (
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
