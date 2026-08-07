import { useThemeColor } from "heroui-native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { cn } from "@/lib/utils";
import { IconPlus } from "./icons";
import { layout, useBrandColor } from "./theme";

const SIZE = 56;

/**
 * The single floating primary action per screen. Carries the same gradient and
 * glow as `BrandButton` so "the purple thing" always means "primary action".
 */
export function Fab({
	onPress,
	accessibilityLabel,
	className,
}: {
	onPress: () => void;
	accessibilityLabel: string;
	className?: string;
}) {
	const insets = useSafeAreaInsets();
	const accent = useThemeColor("accent");
	const [accentDeep] = useBrandColor(["accentDeep"]);

	return (
		<Pressable
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={accessibilityLabel}
			className={cn("absolute right-5 overflow-hidden rounded-full", className)}
			style={{
				bottom: insets.bottom + layout.tabBarHeight + layout.gap.md,
				width: SIZE,
				height: SIZE,
				shadowColor: accentDeep,
				shadowOpacity: 0.45,
				shadowRadius: 16,
				shadowOffset: { width: 0, height: 8 },
				elevation: 10,
			}}
		>
			<Svg
				width={SIZE}
				height={SIZE}
				style={{ position: "absolute", top: 0, left: 0 }}
			>
				<Defs>
					<LinearGradient id="fab" x1="0" y1="0" x2="0" y2="1">
						<Stop offset="0" stopColor={accent} />
						<Stop offset="1" stopColor={accentDeep} />
					</LinearGradient>
				</Defs>
				<Rect
					x="0"
					y="0"
					width={SIZE}
					height={SIZE}
					rx={SIZE / 2}
					fill="url(#fab)"
				/>
			</Svg>
			<View className="flex-1 items-center justify-center">
				<IconPlus size={24} className="text-accent-foreground" />
			</View>
		</Pressable>
	);
}
