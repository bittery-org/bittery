import { useItems } from "@bittery/hooks";
import { useRouter } from "expo-router";
import { Card, Chip, Skeleton, TextField } from "heroui-native";
import { Search, Tag } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";

// Create styled icon components
const StyledSearch = withUniwind(Search);
const StyledTag = withUniwind(Tag);

interface TagWithCount {
  name: string;
  count: number;
}

// Generate a consistent color based on tag name
function getTagColor(
  name: string,
): "default" | "success" | "warning" | "danger" | "accent" {
  const colors: Array<"default" | "success" | "warning" | "danger" | "accent"> =
    ["accent", "success", "warning", "danger", "default"];

  // Simple hash based on tag name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
}

export default function TagsScreen() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");

  const { items, isLoading, error } = useItems();

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
    return tagsWithCounts.filter((tag) =>
      tag.name.toLowerCase().includes(query),
    );
  }, [tagsWithCounts, searchQuery]);

  const handleTagPress = (tagName: string) => {
    router.push(`/tags/${encodeURIComponent(tagName)}`);
  };

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
        {/* Search Skeleton */}
        <View className="border-border border-b px-4 py-3">
          <TextField>
            <View className="w-full flex-row items-center">
              <TextField.Input
                placeholder="Search tags..."
                editable={false}
                className="flex-1 pr-4 pl-12"
              />
              <StyledSearch
                size={18}
                className="absolute left-3.5 text-muted"
                pointerEvents="none"
              />
            </View>
          </TextField>
        </View>

        {/* Skeleton chips */}
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
          <View className="flex-row flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <Skeleton key={i} className="h-8 w-20 rounded-full" />
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView
        className="flex-1 items-center justify-center bg-background p-8"
        edges={["bottom"]}
      >
        <Card variant="secondary" className="w-full max-w-sm items-center p-8">
          <Card.Title className="mb-4 text-center text-danger text-lg">
            Error loading tags
          </Card.Title>
        </Card>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
      {/* Search */}
      <View className="border-border border-b px-4 py-3">
        <TextField>
          <View className="w-full flex-row items-center">
            <TextField.Input
              placeholder="Search tags..."
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              className="flex-1 pr-4 pl-12"
            />
            <StyledSearch
              size={18}
              className="absolute left-3.5 text-muted"
              pointerEvents="none"
            />
          </View>
        </TextField>
      </View>

      {/* Tags Grid */}
      {filteredTags.length === 0 ? (
        <View className="flex-1 items-center justify-center p-8">
          <Card
            variant="secondary"
            className="w-full max-w-sm items-center p-8"
          >
            <StyledTag size={48} className="mb-4 text-muted" />
            <Card.Title className="mb-2 text-center text-lg">
              {searchQuery ? "No tags found" : "No tags yet"}
            </Card.Title>
            <Card.Description className="text-center">
              {searchQuery
                ? "Try a different search term"
                : "Add tags to your items to organize them"}
            </Card.Description>
          </Card>
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
          <View className="flex-row flex-wrap gap-2">
            {filteredTags.map((tag) => {
              return (
                <Chip
                  key={tag.name}
                  variant="soft"
				  color="default"
                  onPress={() => handleTagPress(tag.name)}
                  size="lg"
                  className="pr-2"
                >
                  <StyledTag size={14} className="text-foreground" />
                  <Chip.Label className="font-medium mx-0.5">
                    {tag.name}
                  </Chip.Label>
                  <View className="min-w-5 items-center justify-center rounded-full bg-surface-tertiary px-1.5 my-0.5">
                    <Text className="font-semibold text-foreground/60 text-xs">
                      {tag.count}
                    </Text>
                  </View>
                </Chip>
              );
            })}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
