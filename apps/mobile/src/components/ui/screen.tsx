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
	/** Rendered below the compact row as the screen's large title. */
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

	return (
		<View className={cn(bordered ? "border-border border-b" : "", className)}>
			<View
				className="flex-row items-center gap-2 px-4"
				style={{ height: layout.appBarHeight }}
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
				{title ? (
					<Text
						numberOfLines={1}
						className="min-w-0 flex-1 font-semibold text-foreground text-lg"
					>
						{title}
					</Text>
				) : (
					<View className="flex-1" />
				)}
				{actions ? (
					<View className="flex-row items-center gap-1.5">{actions}</View>
				) : null}
			</View>
			{largeTitle ? (
				<View className="px-4 pt-1 pb-3">
					<Text
						numberOfLines={1}
						className="font-semibold text-3xl text-foreground tracking-tight"
					>
						{largeTitle}
					</Text>
					{subtitle ? (
						<Text numberOfLines={1} className="mt-1 text-muted text-sm">
							{subtitle}
						</Text>
					) : null}
				</View>
			) : null}
		</View>
	);
}
