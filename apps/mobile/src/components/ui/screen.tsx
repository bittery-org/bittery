import { useRouter } from "expo-router";
import { PressableFeedback } from "heroui-native";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "@/lib/utils";
import { Aurora } from "./brand";
import { IconArrowLeft } from "./icons";
import { iconSize, layout } from "./theme";

/**
 * Bottom padding a scroll view needs so its last row clears the tab bar and the
 * home indicator.
 */
export function useBottomInset({
	tabBar = false,
	extra = layout.gap.lg,
}: {
	tabBar?: boolean;
	extra?: number;
} = {}) {
	const insets = useSafeAreaInsets();
	return insets.bottom + (tabBar ? layout.tabBarHeight : 0) + extra;
}

interface ScreenProps {
	children: React.ReactNode;
	/** Paints the sanctioned top wash. Items, Browse, auth and unlock only. */
	aurora?: boolean;
	/** Sheets and modals sit on the popover rung instead of the canvas. */
	surface?: "background" | "overlay";
	className?: string;
}

/** Canvas for every route: safe-area top, themed background, optional aurora. */
export function Screen({
	children,
	aurora = false,
	surface = "background",
	className,
}: ScreenProps) {
	const insets = useSafeAreaInsets();

	return (
		<View
			className={cn(
				"flex-1",
				surface === "overlay" ? "bg-surface-secondary" : "bg-background",
				className,
			)}
			style={{ paddingTop: insets.top }}
		>
			{aurora ? <Aurora /> : null}
			{children}
		</View>
	);
}

interface AppBarProps {
	title?: string;
	/**
	 * The screen's large title. It shares its row with the back affordance,
	 * `leading` and `actions` rather than stacking below them — a phone has no
	 * vertical space to spend on a header band that only holds an avatar.
	 */
	largeTitle?: string;
	subtitle?: string;
	leading?: React.ReactNode;
	actions?: React.ReactNode;
	/** Shows a back affordance; defaults to `router.back()`. */
	onBack?: () => void;
	showBack?: boolean;
	/** Hairline under the bar — turn on for screens whose content scrolls beneath it. */
	bordered?: boolean;
	className?: string;
}

/**
 * The app's only header. Stock navigator headers stay off
 * (`headerShown: false`) so every screen composes this instead.
 */
export function AppBar({
	title,
	largeTitle,
	subtitle,
	leading,
	actions,
	onBack,
	showBack = false,
	bordered = false,
	className,
}: AppBarProps) {
	const router = useRouter();
	const isLarge = Boolean(largeTitle) && !title;

	return (
		<View className={cn(bordered ? "border-border border-b" : "", className)}>
			<View
				className={cn(
					"flex-row items-center gap-2 px-4",
					isLarge ? "py-1.5" : "",
				)}
				style={isLarge ? undefined : { height: layout.appBarHeight }}
			>
				{showBack ? (
					<PressableFeedback
						onPress={onBack ?? (() => router.back())}
						className="-ml-2 h-9 w-9 items-center justify-center rounded-full"
					>
						<PressableFeedback.Highlight />
						<IconArrowLeft size={iconSize.bar} className="text-foreground" />
					</PressableFeedback>
				) : null}
				{leading}
				{isLarge || title ? (
					<View className="min-w-0 flex-1">
						<Text
							numberOfLines={1}
							className={cn(
								"font-semibold text-foreground",
								isLarge ? "text-3xl tracking-tight" : "text-lg",
							)}
						>
							{largeTitle ?? title}
						</Text>
						{subtitle ? (
							<Text numberOfLines={1} className="text-muted text-sm">
								{subtitle}
							</Text>
						) : null}
					</View>
				) : (
					<View className="flex-1" />
				)}
				{actions ? (
					<View className="flex-row items-center gap-1.5">{actions}</View>
				) : null}
			</View>
		</View>
	);
}
