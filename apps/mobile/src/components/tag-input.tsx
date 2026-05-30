import {
	Button,
	Chip,
	Description,
	Input,
	Label,
	TextField,
} from "heroui-native";
import { X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { withUniwind } from "uniwind";

const StyledX = withUniwind(X);

import { useI18n } from "@/providers/i18n-provider";

interface TagInputProps {
	tags: string[];
	onTagsChange: (tags: string[]) => void;
	placeholder?: string;
	label?: string;
	maxTags?: number;
}

export function TagInput({
	tags,
	onTagsChange,
	placeholder: placeholderProp,
	label: labelProp,
	maxTags = 10,
}: TagInputProps) {
	const { m } = useI18n();
	const label = labelProp ?? m.mob_tag_input_default_label();
	const placeholder = placeholderProp ?? m.mob_tag_input_default_placeholder();
	const [inputValue, setInputValue] = useState("");

	const handleAddTag = () => {
		const trimmedValue = inputValue.trim();

		if (!trimmedValue) return;

		// Check if tag already exists (case-insensitive)
		if (tags.some((tag) => tag.toLowerCase() === trimmedValue.toLowerCase())) {
			setInputValue("");
			return;
		}

		// Check max tags limit
		if (tags.length >= maxTags) {
			return;
		}

		onTagsChange([...tags, trimmedValue]);
		setInputValue("");
	};

	const handleRemoveTag = (tagToRemove: string) => {
		onTagsChange(tags.filter((tag) => tag !== tagToRemove));
	};

	const handleKeyPress = (e: any) => {
		// Handle Enter or comma to add tag
		if (e.nativeEvent.key === "Enter" || e.nativeEvent.key === ",") {
			e.preventDefault();
			handleAddTag();
		}
	};

	return (
		<View className="mb-4">
			<Label className="mb-2">{label}</Label>

			{/* Tag Display Area */}
			{tags.length > 0 && (
				<ScrollView
					horizontal
					showsHorizontalScrollIndicator={false}
					className="mb-2"
					contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
				>
					{tags.map((tag) => (
						<Chip key={tag} size="sm" variant="secondary">
							<Chip.Label>{tag}</Chip.Label>
							<Pressable
								onPress={() => handleRemoveTag(tag)}
								hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
							>
								<StyledX size={14} className="ml-1 text-muted" />
							</Pressable>
						</Chip>
					))}
				</ScrollView>
			)}

			{/* Tag Input Field */}
			<View className="flex-row items-start gap-2">
				<TextField className="flex-1">
					<Input
						placeholder={placeholder}
						value={inputValue}
						onChangeText={setInputValue}
						onKeyPress={handleKeyPress}
						onSubmitEditing={handleAddTag}
						returnKeyType="done"
						autoCapitalize="none"
						autoCorrect={false}
					/>
					{tags.length >= maxTags && (
						<Description>{m.mob_tag_input_max_reached({ count: String(maxTags) })}</Description>
					)}
				</TextField>
				<Button
					onPress={handleAddTag}
					variant="secondary"
					size="md"
					isDisabled={!inputValue.trim() || tags.length >= maxTags}
				>
					{m.mob_tag_input_add_button()}
				</Button>
			</View>
		</View>
	);
}
