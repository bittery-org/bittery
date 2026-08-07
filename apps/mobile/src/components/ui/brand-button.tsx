import { useThemeColor } from "heroui-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useUniwind } from "uniwind";
import { cn } from "@/lib/utils";
import { useBrandColor } from "./theme";

interface BrandButtonProps {
	label: string;
	onPress?: () => void;
	isDisabled?: boolean;
	isLoading?: boolean;
	/** Full-bleed inside its container; the default for form submits. */
	fullWidth?: boolean;
	size?: "md" | "lg";
	leading?: React.ReactNode;
	className?: string;
}

const HEIGHTS = { md: 44, lg: 52 } as const;

/**
 * The primary action: accent → accent-deep gradient, 1px top inset highlight and
 * an accent glow in dark mode. Never rebuild this with `Button` plus classes.
 */
export function BrandButton({
	label,
	onPress,
	isDisabled = false,
	isLoading = false,
	fullWidth = true,
	size = "md",
	leading,
	className,
}: BrandButtonProps) {
	const { theme } = useUniwind();
	const [accent, accentForeground] = useThemeColor([
		"accent",
		"accent-foreground",
	]);
	const [accentDeep] = useBrandColor(["accentDeep"]);
	const height = HEIGHTS[size];
	const inert = isDisabled || isLoading;

	return (
		<Pressable
			onPress={onPress}
			disabled={inert}
			className={cn(
				"overflow-hidden rounded-xl",
				fullWidth ? "w-full" : "self-start",
				className,
			)}
			style={[
				{ height },
				inert ? { opacity: 0.5 } : null,
				theme === "dark" && !inert
					? {
							shadowColor: accentDeep,
							shadowOpacity: 0.45,
							shadowRadius: 14,
							shadowOffset: { width: 0, height: 6 },
							elevation: 8,
						}
					: null,
			]}
		>
			<Svg
				width="100%"
				height={height}
				style={{ position: "absolute", top: 0, left: 0 }}
			>
				<Defs>
					<LinearGradient id="brandButton" x1="0" y1="0" x2="0" y2="1">
						<Stop offset="0" stopColor={accent} />
						<Stop offset="1" stopColor={accentDeep} />
					</LinearGradient>
				</Defs>
				<Rect
					x="0"
					y="0"
					width="100%"
					height={height}
					fill="url(#brandButton)"
				/>
			</Svg>
			<View
				pointerEvents="none"
				className="absolute top-0 right-0 left-0 h-px"
				style={{ backgroundColor: "rgba(255,255,255,0.22)" }}
			/>
			<View className="flex-1 flex-row items-center justify-center gap-2 px-5">
				{isLoading ? (
					<ActivityIndicator size="small" color={accentForeground} />
				) : (
					leading
				)}
				<Text className="font-semibold text-accent-foreground text-base">
					{label}
				</Text>
			</View>
		</Pressable>
	);
}
