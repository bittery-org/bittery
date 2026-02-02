import { Stack } from "expo-router";

export default function VaultLayout() {
	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: { backgroundColor: "#ffffff" },
			}}
		>
			<Stack.Screen name="index" />
			<Stack.Screen name="[vaultId]/index" />
			<Stack.Screen name="[vaultId]/[itemId]" />
			<Stack.Screen name="create" />
		</Stack>
	);
}
