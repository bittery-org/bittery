import { Pressable, type PressableProps } from "react-native";
import Animated, {
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

const StyledAnimatedView = withUniwind(Animated.View);

interface PressScaleProps extends Omit<PressableProps, "style"> {
	/** Rest → pressed scale. Cards use the default; small controls should stay at 1. */
	scale?: number;
	className?: string;
	children?: React.ReactNode;
}

/** The 120ms press response every card and tile shares. */
export function PressScale({
	scale = 0.985,
	className,
	children,
	onPressIn,
	onPressOut,
	...props
}: PressScaleProps) {
	const progress = useSharedValue(0);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ scale: 1 - progress.value * (1 - scale) }],
	}));

	return (
		<Pressable
			{...props}
			onPressIn={(event) => {
				progress.value = withTiming(1, { duration: 120 });
				onPressIn?.(event);
			}}
			onPressOut={(event) => {
				progress.value = withTiming(0, { duration: 160 });
				onPressOut?.(event);
			}}
		>
			<StyledAnimatedView className={className} style={animatedStyle}>
				{children}
			</StyledAnimatedView>
		</Pressable>
	);
}
