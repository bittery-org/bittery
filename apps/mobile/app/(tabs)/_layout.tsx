import { Tabs } from "expo-router";
import { useThemeColor } from "heroui-native";
import { Home, Search, Shield, Tag } from "lucide-react-native";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountSwitcher } from "../../src/components/account-switcher";
import { useI18n } from "@/providers/i18n-provider";

export default function TabsLayout() {
	const { m } = useI18n();
	const insets = useSafeAreaInsets();
	const [accent, foreground, surface, border, muted] = useThemeColor([
		"accent",
		"foreground",
		"surface",
		"border",
		"muted",
		"background",
	]);

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
					title: m.mob_tab_all_items(),
					tabBarIcon: ({ color, size }) => <Home size={size} color={color} />,
					headerTitle: m.mob_tab_all_items(),
				}}
			/>
			<Tabs.Screen
				name="search"
				options={{
					title: m.mob_tab_search(),
					tabBarIcon: ({ color, size }) => <Search size={size} color={color} />,
					headerTitle: m.mob_tab_search(),
				}}
			/>
			<Tabs.Screen
				name="tags"
				options={{
					title: m.mob_tab_tags(),
					tabBarIcon: ({ color, size }) => <Tag size={size} color={color} />,
					headerTitle: m.mob_tab_tags(),
				}}
			/>
			<Tabs.Screen
				name="vaults"
				options={{
					title: m.mob_tab_vaults(),
					tabBarIcon: ({ color, size }) => <Shield size={size} color={color} />,
					headerTitle: m.mob_tab_vaults(),
				}}
			/>
			{/* Trash is hidden from tabs, accessible from account switcher menu */}
			<Tabs.Screen
				name="trash"
				options={{
					href: null,
					headerTitle: m.mob_tab_trash(),
				}}
			/>
		</Tabs>
	);
}
