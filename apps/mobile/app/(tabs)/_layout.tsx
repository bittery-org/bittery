import { Tabs } from "expo-router";
import { useThemeColor } from "heroui-native";
import { Home, Search, Shield, Tag } from "lucide-react-native";
import { Platform, View } from "react-native";
import { AccountSwitcher } from "../../src/components/account-switcher";
import { useCredentialProviderSync } from "../../src/hooks/use-credential-provider-sync";

export default function TabsLayout() {
	const [accent, foreground, surface, border, muted] = useThemeColor([
		"accent",
		"foreground",
		"surface",
		"border",
		"muted",
		"background",
	]);

	// Sync vault credentials to Android Credential Manager for autofill
	// This runs silently in the background when vault items change
	useCredentialProviderSync({
		enabled: Platform.OS === "android",
		autoSync: true,
		debounceMs: 3000, // Wait 3s after changes before syncing
	});

	return (
		<Tabs
			screenOptions={{
				tabBarActiveTintColor: accent,
				tabBarInactiveTintColor: muted,
				tabBarStyle: {
					position: "absolute",
					bottom: 16,
					marginHorizontal: 40,
					alignSelf: "center",
					borderTopWidth: 0,
					borderRadius: 20,
					backgroundColor: surface,
					height: 64,
					paddingBottom: 8,
					paddingTop: 8,
					paddingHorizontal: 8,
					shadowColor: foreground,
					shadowOffset: { width: 0, height: 4 },
					shadowOpacity: 0.1,
					shadowRadius: 12,
					elevation: 8,
				},
				tabBarItemStyle: {
					paddingHorizontal: 4,
				},
				tabBarLabelStyle: {
					fontSize: 11,
					fontWeight: "500",
				},
				headerStyle: {
					backgroundColor: surface,
					shadowColor: "transparent",
					borderBottomWidth: 0,
					borderBottomColor: border,
					height: 110,
				},
				headerTitleStyle: {
					fontWeight: "600",
					fontSize: 18,
				},
				headerLeft: () => (
					<View className="ml-4">
						<AccountSwitcher />
					</View>
				),
			}}
		>
			<Tabs.Screen
				name="index"
				options={{
					title: "All Items",
					tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
					headerTitle: "All Items",
				}}
			/>
			<Tabs.Screen
				name="search"
				options={{
					title: "Search",
					tabBarIcon: ({ color, size }) => <Search size={size} color={color} />,
					headerTitle: "Search",
				}}
			/>
			<Tabs.Screen
				name="tags"
				options={{
					title: "Tags",
					tabBarIcon: ({ color, size }) => <Tag size={size} color={color} />,
					headerTitle: "Tags",
				}}
			/>
			<Tabs.Screen
				name="vaults"
				options={{
					title: "Vaults",
					tabBarIcon: ({ color, size }) => <Shield size={size} color={color} />,
					headerTitle: "Vaults",
				}}
			/>
			{/* Trash is hidden from tabs, accessible from account switcher menu */}
			<Tabs.Screen
				name="trash"
				options={{
					href: null,
				}}
			/>
		</Tabs>
	);
}
