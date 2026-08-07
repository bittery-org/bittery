import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";

/**
 * Identity surfaces. Both screens paint their own `AppBar`/lockup, so stock
 * headers stay off and the stack only carries the canvas colour and motion.
 */
export default function AuthLayout() {
	const [background] = useThemeColor(["background"]);

	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: { backgroundColor: background },
				animation: "fade",
				animationDuration: 180,
			}}
		>
			<Stack.Screen name="login" />
			<Stack.Screen name="unlock" />
		</Stack>
	);
}
