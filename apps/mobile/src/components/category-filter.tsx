import type { ItemCategory } from "@bittery/shared/types";
import { useMemo } from "react";
import { View } from "react-native";
import {
	type AppIcon,
	ChipRail,
	type FilterChip,
	IconCreditCard,
	IconFileText,
	IconGrid,
	IconKey,
	IconTimer,
	IconUser,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

type CategoryValue = ItemCategory | "all";

const CATEGORY_ICONS: Record<CategoryValue, AppIcon> = {
	all: IconGrid,
	login: IconKey,
	"credit-card": IconCreditCard,
	identity: IconUser,
	"secure-note": IconFileText,
	totp: IconTimer,
};

export interface CategoryFilterProps {
	selectedCategory: CategoryValue;
	onCategoryChange: (category: CategoryValue) => void;
	/** Row counts keyed by category, rendered on the chips when supplied. */
	counts?: Partial<Record<CategoryValue, number>>;
	className?: string;
}

/** Horizontal item-category rail. Replaces the old dropdown filter. */
export function CategoryFilter({
	selectedCategory,
	onCategoryChange,
	counts,
	className,
}: CategoryFilterProps) {
	const { m } = useI18n();

	const chips = useMemo<FilterChip<CategoryValue>[]>(() => {
		const labels: Array<[CategoryValue, string]> = [
			["all", m.mob_category_chip_all()],
			["login", m.mob_category_login()],
			["credit-card", m.mob_category_credit_card()],
			["identity", m.mob_category_identity()],
			["secure-note", m.mob_category_secure_note()],
			["totp", m.mob_category_totp()],
		];

		return labels.map(([value, label]) => ({
			value,
			label,
			icon: CATEGORY_ICONS[value],
			count: counts?.[value],
		}));
	}, [m, counts]);

	// The wrapper pins the rail to its content height; a bare horizontal
	// ScrollView would otherwise stretch into the list below it.
	return (
		<View className={cn("pb-3", className)}>
			<ChipRail
				chips={chips}
				value={selectedCategory}
				onChange={onCategoryChange}
			/>
		</View>
	);
}
