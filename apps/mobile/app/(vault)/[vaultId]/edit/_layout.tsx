import { Stack } from "expo-router";
import { useThemeColor } from "heroui-native";

export default function EditLayout() {
	const [background] = useThemeColor(["background"]);

	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: { backgroundColor: background },
			}}
		/>
	);
}
