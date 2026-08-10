import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";

/**
 * Item routes push over the tabs. Stock headers stay off everywhere — each
 * screen composes `AppBar` itself (see DESIGN-NATIVE.md).
 */
export default function VaultLayout() {
	const [background] = useThemeColor(["background"]);

	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: { backgroundColor: background },
			}}
		>
			<Stack.Screen name="index" />
			<Stack.Screen name="[vaultId]/index" />
			<Stack.Screen name="[vaultId]/[itemId]" />
			<Stack.Screen name="[vaultId]/edit" />
			<Stack.Screen name="create" />
		</Stack>
	);
}
