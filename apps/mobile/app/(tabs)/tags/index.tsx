import { useAllDecryptedItems } from "@bittery/hooks";
import { useRouter } from "expo-router";
import { Search, Tag } from "lucide-react-native";
import { useMemo, useState } from "react";
import {
	ActivityIndicator,
	ScrollView,
	Text,
	TextInput,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { TagChip } from "../../../src/components/tag-chip";

interface TagWithCount {
	name: string;
	count: number;
}

export default function TagsScreen() {
	const router = useRouter();
	const [searchQuery, setSearchQuery] = useState("");

	const { items, isLoading, error } = useAllDecryptedItems();

	// Extract tags with counts from items
	const tagsWithCounts = useMemo((): TagWithCount[] => {
		const tagCounts = new Map<string, number>();
		for (const item of items) {
			if (item.tags) {
				for (const tag of item.tags) {
					tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
				}
			}
		}
		return Array.from(tagCounts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [items]);

	// Filter tags based on search
	const filteredTags = useMemo(() => {
		if (!searchQuery.trim()) return tagsWithCounts;
		const query = searchQuery.toLowerCase();
		return tagsWithCounts.filter((tag) => tag.name.toLowerCase().includes(query));
	}, [tagsWithCounts, searchQuery]);

	const handleTagPress = (tagName: string) => {
		router.push(`/tags/${encodeURIComponent(tagName)}`);
	};

	if (isLoading) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background"
				edges={["bottom"]}
			>
				<ActivityIndicator size="large" color="#000" />
			</SafeAreaView>
		);
	}

	if (error) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background"
				edges={["bottom"]}
			>
				<Text className="text-destructive">Error loading tags</Text>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
			{/* Search */}
			<View className="border-border border-b px-4 py-2">
				<View className="flex-row items-center rounded-lg bg-secondary px-3 py-2">
					<Search size={18} color="#6b7280" />
					<TextInput
						className="ml-2 flex-1 text-foreground"
						placeholder="Search tags..."
						value={searchQuery}
						onChangeText={setSearchQuery}
						placeholderTextColor="#9ca3af"
					/>
				</View>
			</View>

			{/* Tags Grid */}
			{filteredTags.length === 0 ? (
				<View className="flex-1 items-center justify-center p-8">
					<Tag size={48} color="#9ca3af" />
					<Text className="mt-4 text-center font-semibold text-foreground text-lg">
						{searchQuery ? "No tags found" : "No tags yet"}
					</Text>
					<Text className="mt-2 text-center text-muted-foreground">
						{searchQuery
							? "Try a different search term"
							: "Add tags to your items to organize them"}
					</Text>
				</View>
			) : (
				<ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
					<View className="flex-row flex-wrap">
						{filteredTags.map((tag) => (
							<View key={tag.name} className="mr-2 mb-2">
								<TagChip
									name={tag.name}
									count={tag.count}
									onPress={() => handleTagPress(tag.name)}
								/>
							</View>
						))}
					</View>
				</ScrollView>
			)}
		</SafeAreaView>
	);
}
