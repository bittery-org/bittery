import { Tabs } from "expo-router";
import { Home, Search, Shield, Tag } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import {
	AccountAvatarButton,
	AccountSwitcher,
} from "../../src/components/account-switcher";

export default function TabsLayout() {
	const [showAccountSwitcher, setShowAccountSwitcher] = useState(false);

	return (
		<>
			<Tabs
				screenOptions={{
					tabBarActiveTintColor: "#000",
					tabBarInactiveTintColor: "#9ca3af",
					tabBarStyle: {
						borderTopWidth: 1,
						borderTopColor: "#e5e7eb",
					},
					tabBarLabelStyle: {
						fontSize: 12,
						fontWeight: "500",
					},
					headerStyle: {
						backgroundColor: "#fff",
						shadowColor: "transparent",
						borderBottomWidth: 1,
						borderBottomColor: "#e5e7eb",
					},
					headerTitleStyle: {
						fontWeight: "600",
						fontSize: 18,
					},
					headerLeft: () => (
						<View className="ml-4">
							<AccountAvatarButton
								onPress={() => setShowAccountSwitcher(true)}
							/>
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
						tabBarIcon: ({ color, size }) => (
							<Search size={size} color={color} />
						),
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
						tabBarIcon: ({ color, size }) => (
							<Shield size={size} color={color} />
						),
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
			<AccountSwitcher
				visible={showAccountSwitcher}
				onClose={() => setShowAccountSwitcher(false)}
			/>
		</>
	);
}
