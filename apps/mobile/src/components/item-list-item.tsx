import type { ItemCategory } from "@bittery/shared/types";
import {
	CreditCard,
	FileText,
	Key,
	Star,
	Timer,
	User,
} from "lucide-react-native";
import { Text, TouchableOpacity, View } from "react-native";

import { VaultBadge } from "./vault-badge";

const categoryIcons: Record<ItemCategory, typeof Key> = {
	login: Key,
	"credit-card": CreditCard,
	identity: User,
	"secure-note": FileText,
	totp: Timer,
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
}

export function ItemListItem({
	id,
	title,
	category,
	favorite,
	username,
	url,
	vault,
	showVaultBadge = false,
	onPress,
	rightContent,
}: ItemListItemProps) {
	const Icon = categoryIcons[category];

	// Get subtitle based on category
	const getSubtitle = () => {
		if (category === "login" && username) return username;
		if (category === "login" && url) return url;
		if (category === "credit-card") return "Credit Card";
		if (category === "identity") return "Identity";
		if (category === "secure-note") return "Secure Note";
		if (category === "totp") return "TOTP";
		return null;
	};

	const subtitle = getSubtitle();

	return (
		<TouchableOpacity
			onPress={onPress}
			className="flex-row items-center border-border border-b bg-background px-4 py-3"
			activeOpacity={0.7}
		>
			{/* Icon */}
			<View className="mr-3 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
				<Icon size={20} color="#6b7280" />
			</View>

			{/* Content */}
			<View className="min-w-0 flex-1">
				<View className="flex-row items-center">
					<Text
						className="flex-shrink font-medium text-foreground"
						numberOfLines={1}
					>
						{title}
					</Text>
					{favorite && (
						<Star
							size={14}
							color="#eab308"
							fill="#eab308"
							style={{ marginLeft: 6 }}
						/>
					)}
				</View>
				{subtitle && (
					<Text className="text-muted-foreground text-sm" numberOfLines={1}>
						{subtitle}
					</Text>
				)}
				{showVaultBadge && vault && (
					<View className="mt-1">
						<VaultBadge name={vault.name} type={vault.type} />
					</View>
				)}
			</View>

			{/* Right content (optional, e.g., for swipe actions indicator) */}
			{rightContent && <View className="ml-2">{rightContent}</View>}
		</TouchableOpacity>
	);
}
