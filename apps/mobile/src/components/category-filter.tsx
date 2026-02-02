import type { ItemCategory } from "@bittery/shared/types";
import { Chip } from "heroui-native";
import { FlatList, View } from "react-native";
import { categories, categoryLabels } from "../constants/item-categories";

export interface CategoryFilterProps {
	selectedCategory: ItemCategory | "all";
	onCategoryChange: (category: ItemCategory | "all") => void;
}

export function CategoryFilter({
	selectedCategory,
	onCategoryChange,
}: CategoryFilterProps) {
	return (
		<View className="border-border border-b px-4 py-3">
			<FlatList
				horizontal
				showsHorizontalScrollIndicator={false}
				data={categories}
				keyExtractor={(item) => item}
				renderItem={({ item: category }) => (
					<View className="mr-2">
						<Chip
							variant={selectedCategory === category ? "primary" : "secondary"}
							color={selectedCategory === category ? "accent" : "default"}
							onPress={() => onCategoryChange(category)}
							size="md"
						>
							<Chip.Label>{categoryLabels[category]}</Chip.Label>
						</Chip>
					</View>
				)}
				contentContainerStyle={{ paddingVertical: 4 }}
			/>
		</View>
	);
}
