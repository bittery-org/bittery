import {
	Description,
	Input,
	Label,
	PressableFeedback,
	TextField,
} from "heroui-native";
import { useState } from "react";
import { Text, View } from "react-native";
import { IconPlus, IconX, iconSize } from "@/components/ui";
import { cn } from "@/lib/utils";
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

	const isFull = tags.length >= maxTags;
	const canAdd = Boolean(inputValue.trim()) && !isFull;

	const handleAddTag = () => {
		const trimmedValue = inputValue.trim();

		if (!trimmedValue) return;

		// Case-insensitive: the same label twice is one tag, not two.
		if (tags.some((tag) => tag.toLowerCase() === trimmedValue.toLowerCase())) {
			setInputValue("");
			return;
		}

		if (isFull) return;

		onTagsChange([...tags, trimmedValue]);
		setInputValue("");
	};

	const handleRemoveTag = (tagToRemove: string) => {
		onTagsChange(tags.filter((tag) => tag !== tagToRemove));
	};

	return (
		<View>
			<Label className="mb-2">{label}</Label>

			{tags.length > 0 ? (
				<View className="mb-2 flex-row flex-wrap gap-2">
					{tags.map((tag) => (
						<View
							key={tag}
							className="h-8 flex-row items-center gap-1.5 rounded-full border border-border bg-surface pr-1.5 pl-3"
						>
							<Text className="font-medium text-foreground text-sm">{tag}</Text>
							<PressableFeedback
								onPress={() => handleRemoveTag(tag)}
								accessibilityRole="button"
								accessibilityLabel={m.mob_tag_input_default_label()}
								hitSlop={8}
								className="h-5 w-5 items-center justify-center rounded-full"
							>
								<PressableFeedback.Highlight />
								<IconX size={12} className="text-muted" />
							</PressableFeedback>
						</View>
					))}
				</View>
			) : null}

			<View className="flex-row items-start gap-2">
				<TextField className="flex-1">
					<Input
						placeholder={placeholder}
						value={inputValue}
						onChangeText={setInputValue}
						onKeyPress={(event) => {
							const key = event.nativeEvent.key;
							if (key === "Enter" || key === ",") {
								handleAddTag();
							}
						}}
						onSubmitEditing={handleAddTag}
						returnKeyType="done"
						submitBehavior="submit"
						autoCapitalize="none"
						autoCorrect={false}
						editable={!isFull}
					/>
					{isFull ? (
						<Description>
							{m.mob_tag_input_max_reached({ count: String(maxTags) })}
						</Description>
					) : null}
				</TextField>
				<PressableFeedback
					onPress={handleAddTag}
					isDisabled={!canAdd}
					accessibilityRole="button"
					accessibilityLabel={m.mob_tag_input_add_button()}
					className={cn(
						"h-12 flex-row items-center gap-1.5 rounded-xl border border-border bg-surface px-4",
						canAdd ? "" : "opacity-50",
					)}
				>
					<PressableFeedback.Highlight />
					<IconPlus size={iconSize.chip} className="text-accent" />
					<Text className="font-medium text-base text-foreground">
						{m.mob_tag_input_add_button()}
					</Text>
				</PressableFeedback>
			</View>
		</View>
	);
}
