import { Stack } from "expo-router";

export default function AuthLayout() {
	return (
		<Stack
			screenOptions={{
				headerShown: false,
				contentStyle: { backgroundColor: "#ffffff" },
			}}
		>
			<Stack.Screen name="login" />
			<Stack.Screen name="unlock" />
			<Stack.Screen name="signup" />
		</Stack>
	);
}
