import type { ItemCategory } from "@bittery/shared/types";
import { Button, Select } from "heroui-native";
import { ChevronDown } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";
import { withUniwind } from "uniwind";
import { categoryOptions } from "../constants/item-categories";

const StyledChevronDown = withUniwind(ChevronDown);

export interface CategoryFilterProps {
	selectedCategory: ItemCategory | "all";
	onCategoryChange: (category: ItemCategory | "all") => void;
}

export function CategoryFilter({
	selectedCategory,
	onCategoryChange,
}: CategoryFilterProps) {
	const selectedOption = categoryOptions.find(
		(opt) => opt.value === selectedCategory,
	);

	return (
		<View className="pl-0.5">
			<Select
				value={
					selectedOption
						? { value: selectedOption.value, label: selectedOption.label }
						: undefined
				}
				onValueChange={(option) => {
					if (option) {
						onCategoryChange(option.value as ItemCategory | "all");
					}
				}}
			>
				<Select.Trigger variant="unstyled" asChild>
					<Button variant="ghost" size="sm" className="self-start">
						{selectedOption && (
							<selectedOption.icon
								size={16}
								className="text-surface-foreground"
							/>
						)}
						<Button.Label>{selectedOption?.label}</Button.Label>
						<StyledChevronDown size={16} className="text-surface-foreground" />
					</Button>
				</Select.Trigger>
				<Select.Portal>
					<Select.Overlay />
					<Select.Content
						presentation="popover"
						placement="bottom"
						align="start"
						width={220}
					>
						<ScrollView className="max-h-72">
							{categoryOptions.map((option) => {
								const Icon = option.icon;
								return (
									<Select.Item
										key={option.value}
										value={option.value}
										label={option.label}
									>
										<View className="flex-1 flex-row items-center gap-3">
											<Icon size={18} className="text-muted" />
											<Text className="flex-1 text-base text-foreground">
												{option.label}
											</Text>
										</View>
										<Select.ItemIndicator />
									</Select.Item>
								);
							})}
						</ScrollView>
					</Select.Content>
				</Select.Portal>
			</Select>
		</View>
	);
}
