import { Tabs } from "expo-router";
import {
	createTabBar,
	IconHome,
	IconLibrary,
	IconSearch,
	IconSettings,
} from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

const TabBar = createTabBar({
	index: IconHome,
	search: IconSearch,
	vaults: IconLibrary,
	settings: IconSettings,
});

export default function TabsLayout() {
	const { m } = useI18n();

	return (
		<Tabs
			tabBar={(props) => <TabBar {...props} />}
			screenOptions={{
				headerShown: false,
				sceneStyle: { backgroundColor: "transparent" },
			}}
		>
			<Tabs.Screen name="index" options={{ title: m.mob_tab_all_items() }} />
			<Tabs.Screen name="search" options={{ title: m.mob_tab_search() }} />
			<Tabs.Screen name="vaults" options={{ title: m.mob_browse_title() }} />
			<Tabs.Screen
				name="settings"
				options={{ title: m.mob_settings_title() }}
			/>
			{/* Reachable from Browse and the account sheet, never from the tab bar. */}
			<Tabs.Screen name="tags" options={{ href: null }} />
			<Tabs.Screen name="trash" options={{ href: null }} />
		</Tabs>
	);
}
