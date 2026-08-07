import { PressableFeedback } from "heroui-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { IconChevronRight, IconUsers, iconSize, layout } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import { VaultAvatar } from "./vault-avatar";

interface VaultListItemProps {
	id: string;
	name: string;
	type: "personal" | "team";
	role: string;
	icon?: string | null;
	imageUrl?: string | null;
	itemCount?: number;
	accountLabel?: string;
	onPress: () => void;
	isFirstInSection?: boolean;
	isLastInSection?: boolean;
}

export const VaultListItem = memo(function VaultListItem({
	id: _id,
	name,
	type,
	role,
	icon,
	imageUrl,
	itemCount,
	accountLabel,
	onPress,
	isFirstInSection = false,
	isLastInSection = false,
}: VaultListItemProps) {
	const { m } = useI18n();
	const isShared = type === "team";

	const subtitle = [
		accountLabel,
		role,
		itemCount === undefined
			? null
			: itemCount === 1
				? m.mob_item_count_singular({ count: String(itemCount) })
				: m.mob_item_count_plural({ count: String(itemCount) }),
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<View className="px-4">
			<View
				className={cn(
					"overflow-hidden border-border border-x bg-surface",
					isFirstInSection ? "rounded-t-2xl border-t" : "",
					isLastInSection ? "rounded-b-2xl border-b" : "",
				)}
			>
				{isFirstInSection ? null : <View className="ml-14 h-px bg-border" />}
				<PressableFeedback
					onPress={onPress}
					className="flex-row items-center px-3.5"
					style={{ minHeight: layout.rowHeight }}
				>
					<PressableFeedback.Highlight />
					<VaultAvatar
						name={name}
						icon={icon}
						imageUrl={imageUrl}
						size="md"
						className="mr-3"
					/>
					<View className="min-w-0 flex-1">
						<View className="flex-row items-center gap-1.5">
							<Text
								numberOfLines={1}
								className="shrink font-medium text-base text-foreground"
							>
								{name}
							</Text>
							{isShared ? (
								<View className="shrink-0 flex-row items-center gap-1 rounded-full border border-border bg-surface-secondary px-1.5 py-0.5">
									<IconUsers size={10} className="text-muted" />
									<Text className="text-2xs text-muted">
										{m.mob_vault_item_type_team()}
									</Text>
								</View>
							) : null}
						</View>
						{subtitle ? (
							<Text numberOfLines={1} className="mt-0.5 text-muted text-sm">
								{subtitle}
							</Text>
						) : null}
					</View>
					<IconChevronRight
						size={iconSize.row}
						className="ml-2 shrink-0 text-muted opacity-60"
					/>
				</PressableFeedback>
			</View>
		</View>
	);
});
