import type { ItemCategory } from "@bittery/shared/types";
import type { PopoverTriggerRef } from "heroui-native";
import { Popover, PressableFeedback } from "heroui-native";
import type { RefObject } from "react";
import { Text, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useUniwind } from "uniwind";
import {
	AppBar,
	type AppIcon,
	GradientTile,
	IconCreditCard,
	IconFileText,
	IconHistory,
	IconKey,
	IconMoreVertical,
	IconPencil,
	IconShare,
	IconStar,
	IconTimer,
	IconTrash,
	IconUser,
	iconSize,
	SheetBrandAccent,
	useBrandColor,
} from "@/components/ui";
import { getCategoryLabels } from "@/constants/item-categories";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

const CATEGORY_GLYPHS: Record<ItemCategory, AppIcon> = {
	login: IconKey,
	"credit-card": IconCreditCard,
	identity: IconUser,
	"secure-note": IconFileText,
	totp: IconTimer,
};

const GLOW_HEIGHT = 180;

/**
 * The item-detail brand moment: a radial accent-deep wash behind the title,
 * dimmer than the screen aurora so the header reads as a halo, not a banner.
 */
function HeaderGlow() {
	const { theme } = useUniwind();
	const [accentDeep] = useBrandColor(["accentDeep"]);
	const peak = theme === "dark" ? 0.09 : 0.06;

	return (
		<View
			pointerEvents="none"
			className="absolute top-0 right-0 left-0"
			style={{ height: GLOW_HEIGHT }}
		>
			<Svg width="100%" height="100%">
				<Defs>
					<RadialGradient
						id="itemHeaderGlow"
						cx="50%"
						cy="18%"
						rx="70%"
						ry="90%"
					>
						<Stop offset="0" stopColor={accentDeep} stopOpacity={peak} />
						<Stop offset="1" stopColor={accentDeep} stopOpacity={0} />
					</RadialGradient>
				</Defs>
				<Rect
					x="0"
					y="0"
					width="100%"
					height="100%"
					fill="url(#itemHeaderGlow)"
				/>
			</Svg>
		</View>
	);
}

function MenuRow({
	icon: Icon,
	label,
	onPress,
	isDisabled = false,
	tone = "default",
}: {
	icon: AppIcon;
	label: string;
	onPress: () => void;
	isDisabled?: boolean;
	tone?: "default" | "danger";
}) {
	return (
		<PressableFeedback
			onPress={onPress}
			isDisabled={isDisabled}
			accessibilityRole="button"
			accessibilityLabel={label}
			className={cn(
				"h-11 flex-row items-center gap-3 rounded-xl px-3",
				isDisabled ? "opacity-50" : "",
			)}
		>
			<PressableFeedback.Highlight />
			<Icon
				size={iconSize.row}
				className={tone === "danger" ? "text-danger" : "text-muted"}
			/>
			<Text
				className={cn(
					"font-medium text-base",
					tone === "danger" ? "text-danger" : "text-foreground",
				)}
			>
				{label}
			</Text>
		</PressableFeedback>
	);
}

interface ItemHeaderProps {
	item: {
		category: ItemCategory;
		url?: string;
		serverUrl?: string;
		title: string;
		favorite?: boolean;
	};
	vaultId: string;
	onBack: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onShare: () => void;
	onPasswordHistory?: () => void;
	isDeleting: boolean;
	isSharing?: boolean;
	popoverRef: RefObject<PopoverTriggerRef | null>;
}

export function ItemHeader({
	item,
	vaultId: _vaultId,
	onBack,
	onEdit,
	onDelete,
	onShare,
	onPasswordHistory,
	isDeleting,
	isSharing,
	popoverRef,
}: ItemHeaderProps) {
	const { m } = useI18n();
	const categoryLabels = getCategoryLabels(m);
	const Glyph = CATEGORY_GLYPHS[item.category];

	return (
		<View>
			<HeaderGlow />
			<AppBar
				showBack
				onBack={onBack}
				actions={
					<>
						<PressableFeedback
							onPress={onEdit}
							accessibilityRole="button"
							accessibilityLabel={m.mob_item_header_action_edit()}
							className="h-9 w-9 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconPencil size={iconSize.bar} className="text-foreground" />
						</PressableFeedback>
						<Popover presentation="popover">
							<Popover.Trigger ref={popoverRef} asChild>
								<PressableFeedback
									accessibilityRole="button"
									accessibilityLabel={m.mob_a11y_more_actions()}
									className="h-9 w-9 items-center justify-center rounded-full"
								>
									<PressableFeedback.Highlight />
									<IconMoreVertical
										size={iconSize.bar}
										className="text-foreground"
									/>
								</PressableFeedback>
							</Popover.Trigger>
							<Popover.Portal>
								<Popover.Overlay />
								<Popover.Content
									presentation="popover"
									className="overflow-hidden rounded-2xl bg-surface-secondary p-1.5"
								>
									<SheetBrandAccent height={48} />
									<Popover.Title className="hidden">
										{m.mob_a11y_more_actions()}
									</Popover.Title>
									<MenuRow
										icon={IconPencil}
										label={m.mob_item_header_action_edit()}
										onPress={() => {
											popoverRef.current?.close();
											onEdit();
										}}
									/>
									<MenuRow
										icon={IconShare}
										label={
											isSharing
												? m.mob_item_header_action_share_creating()
												: m.mob_item_header_action_share()
										}
										isDisabled={isSharing}
										onPress={() => {
											popoverRef.current?.close();
											onShare();
										}}
									/>
									{item.category === "login" && onPasswordHistory ? (
										<MenuRow
											icon={IconHistory}
											label={m.mob_item_header_action_password_history()}
											onPress={() => {
												popoverRef.current?.close();
												onPasswordHistory();
											}}
										/>
									) : null}
									<MenuRow
										icon={IconTrash}
										tone="danger"
										label={
											isDeleting
												? m.mob_item_header_action_deleting()
												: m.mob_item_header_action_delete()
										}
										isDisabled={isDeleting}
										onPress={onDelete}
									/>
								</Popover.Content>
							</Popover.Portal>
						</Popover>
					</>
				}
			/>

			<View className="items-center px-6 pt-2 pb-6">
				<GradientTile name={item.title} size={56} radius={16} glow>
					<Glyph size={iconSize.header} className="text-white" />
				</GradientTile>
				<View className="mt-4 flex-row items-center gap-2">
					<Text
						numberOfLines={2}
						className="text-center font-semibold text-2xl text-foreground tracking-tight"
					>
						{item.title}
					</Text>
					{item.favorite ? (
						<View accessibilityLabel={m.mob_a11y_favorite()}>
							<IconStar size={iconSize.chip} className="text-warning" />
						</View>
					) : null}
				</View>
				<Text className="mt-1 text-muted text-sm">
					{categoryLabels[item.category]}
				</Text>
			</View>
		</View>
	);
}
