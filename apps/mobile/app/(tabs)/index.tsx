import { useItems } from "@bittery/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { Tabs, useRouter } from "expo-router";
import { Button, Card, Skeleton } from "heroui-native";
import { Key, Plus } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemSectionsList } from "@/components/item-sections-list";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import { SafeAreaView } from "@/components/safe-area-view";
import { useFilteredItems } from "@/hooks/use-filtered-items";

// Create styled icon components
const StyledKey = withUniwind(Key);
const StyledPlus = withUniwind(Plus);

export default function AllItemsScreen() {
  const router = useRouter();
  const [selectedCategory, setSelectedCategory] = useState<
    ItemCategory | "all"
  >("all");
  const [refreshing, setRefreshing] = useState(false);

  const { items, isLoading, error, refetch } = useItems();

  // Filter and sort items
  const { favorites, regularItems } = useFilteredItems({
    items,
    searchQuery: "",
    selectedCategory,
  });

  const handleCreateItem = () => {
    router.push("/(vault)/create");
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const hasNoItems = favorites.length === 0 && regularItems.length === 0;
  const hasFilter = selectedCategory !== "all";

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={[]}>
        {/* Category filter skeleton */}
        <View className="border-border border-b px-3 py-2">
          <Skeleton className="h-8 w-20 rounded-lg" />
        </View>

        {/* Skeleton items */}
        <ItemsSkeletonList />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView
        className="flex-1 items-center justify-center bg-background p-8"
        edges={[]}
      >
        <Card variant="secondary" className="w-full max-w-sm items-center p-8">
          <Card.Title className="mb-4 text-center text-destructive text-lg">
            Error loading items
          </Card.Title>
          <Button onPress={handleRefresh} variant="primary">
            Retry
          </Button>
        </Card>
      </SafeAreaView>
    );
  }

  return (
    <>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <Button
              isIconOnly
              variant="primary"
              size="sm"
              onPress={handleCreateItem}
              className="mr-4"
            >
              <StyledPlus size={18} className="text-accent-foreground" />
            </Button>
          ),
        }}
      />
      <SafeAreaView className="flex-1 bg-background" edges={[]}>
        {/* Category Filter */}
        <CategoryFilter
          selectedCategory={selectedCategory}
          onCategoryChange={setSelectedCategory}
        />

        {/* Items List */}
        {hasNoItems ? (
          <EmptyItemsState
            icon={<StyledKey size={48} className="mb-4 text-muted" />}
            title={hasFilter ? "No items found" : "No items yet"}
            description={
              hasFilter
                ? "Try a different filter"
                : "Add items to your vaults to see them here"
            }
          />
        ) : (
          <ItemSectionsList
            favorites={favorites}
            regularItems={regularItems}
            onItemPress={(item) =>
              router.push(`/(vault)/${item.vaultId}/${item.id}`)
            }
            refreshing={refreshing}
            onRefresh={handleRefresh}
            showVaultBadge
          />
        )}
      </SafeAreaView>
    </>
  );
}
