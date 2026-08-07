import { type UnifiedItem, useItems } from "@bittery/core/hooks";
import type { ItemCategory } from "@bittery/shared/types";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";
import { CategoryFilter } from "@/components/category-filter";
import { EmptyItemsState } from "@/components/empty-items-state";
import { ItemSectionsList } from "@/components/item-sections-list";
import { ItemsSkeletonList } from "@/components/items-skeleton-list";
import {
	AppBar,
	ErrorState,
	IconAlertCircle,
	IconTag,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { getTagColorFromName } from "@/lib/tag-color";
import { useI18n } from "@/providers/i18n-provider";

export default function TagFilterScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const { tagName } = useLocalSearchParams<{ tagName: string }>();
	const decodedTagName = decodeURIComponent(tagName || "");
	const bottomInset = useBottomInset({ tabBar: true });

	const [selectedCategory, setSelectedCategory] = useState<
		ItemCategory | "all"
	>("all");
	const [refreshing, setRefreshing] = useState(false);

	const { items, isLoading, error, refetch } = useItems();

	const { favorites, regularItems } = useMemo(() => {
		const needle = decodedTagName.toLowerCase();
		const tagged = items.filter((item) =>
			item.tags?.some((tag) => tag.toLowerCase() === needle),
		);
		const scoped =
			selectedCategory === "all"
				? tagged
				: tagged.filter((item) => item.category === selectedCategory);
		const byTitle = (a: UnifiedItem, b: UnifiedItem) =>
			(a.title || "").localeCompare(b.title || "");

		return {
			favorites: scoped.filter((item) => item.favorite).sort(byTitle),
			regularItems: scoped.filter((item) => !item.favorite).sort(byTitle),
		};
	}, [items, decodedTagName, selectedCategory]);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<Screen>
			<AppBar
				showBack
				title={decodedTagName || m.mob_tag_filter_fallback_title()}
				leading={
					<View
						aria-hidden
						className="h-[7px] w-[7px] rounded-full"
						style={{
							backgroundColor: getTagColorFromName(
								decodedTagName || m.mob_tag_filter_fallback_title(),
							),
						}}
					/>
				}
			/>

			<CategoryFilter
				selectedCategory={selectedCategory}
				onCategoryChange={setSelectedCategory}
			/>

			{isLoading ? (
				<ItemsSkeletonList />
			) : error ? (
				<ErrorState
					icon={IconAlertCircle}
					title={m.mob_tag_filter_error_loading()}
					actionLabel={m.mob_items_button_retry()}
					onAction={handleRefresh}
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
					bottomInset={bottomInset}
					ListEmptyComponent={
						<EmptyItemsState
							icon={IconTag}
							title={m.mob_tag_filter_empty_title()}
							description={
								selectedCategory === "all"
									? m.mob_tag_filter_empty_no_items_description()
									: m.mob_tag_filter_empty_category_description()
							}
						/>
					}
				/>
			)}
		</Screen>
	);
}
