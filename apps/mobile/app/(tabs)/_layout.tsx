import { Tabs } from "expo-router";
import { useThemeColor } from "heroui-native";
import { Home, Search, Shield, Tag } from "lucide-react-native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountSwitcher } from "../../src/components/account-switcher";
import { useCredentialProviderSync } from "../../src/hooks/use-credential-provider-sync";

export default function TabsLayout() {
	const insets = useSafeAreaInsets();
	const enableCredentialSync =
		Platform.OS === "android" &&
		process.env.EXPO_PUBLIC_DISABLE_ANDROID_CREDENTIAL_SYNC !== "true";
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
		enabled: enableCredentialSync,
		autoSync: enableCredentialSync,
		debounceMs: __DEV__ ? 5000 : 3000,
	});

	return (
		<Tabs
			screenOptions={{
				tabBarActiveTintColor: accent,
				tabBarInactiveTintColor: muted,
				tabBarStyle: {
					position: "absolute",
					bottom: 12 + insets.bottom,
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
				headerTitleAlign: "center",
				headerLeftContainerStyle: { paddingLeft: 16 },
				headerRightContainerStyle: { paddingRight: 16 },
				headerTitleStyle: {
					fontWeight: "600",
					fontSize: 18,
					textAlign: "center",
				},
				headerLeft: () => (
					<View>
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
					headerTitle: "Trash",
				}}
			/>
		</Tabs>
	);
}
