import { Stack } from "expo-router";

export default function TagLayout() {
	return (
		<Stack
			screenOptions={{
				headerShown: true,
				headerStyle: {
					backgroundColor: "#fff",
				},
				headerTitleStyle: {
					fontWeight: "600",
					fontSize: 18,
				},
				headerShadowVisible: false,
				headerBackTitle: "Tags",
			}}
		/>
	);
}
