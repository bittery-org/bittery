import { Card } from "heroui-native";
import { Star } from "lucide-react-native";
import { View } from "react-native";
import { withUniwind } from "uniwind";

const StyledStar = withUniwind(Star);

export interface ItemSectionHeaderProps {
	title: string;
	count: number;
}

export function ItemSectionHeader({ title, count }: ItemSectionHeaderProps) {
	return (
		<View className="flex-row items-center px-4 pt-2 pb-2">
			{title === "Favorites" && (
				<StyledStar
					size={14}
					fill="#eab308"
					className="mr-1.5 text-yellow-500"
				/>
			)}
			<Card.Title className="font-semibold text-muted text-xs uppercase tracking-wide">
				{title} ({count})
			</Card.Title>
		</View>
	);
}
