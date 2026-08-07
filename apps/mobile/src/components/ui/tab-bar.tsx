import { BlurView } from "expo-blur";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUniwind } from "uniwind";
import { cn } from "@/lib/utils";
import type { AppIcon } from "./icons";
import { iconSize, layout } from "./theme";

export interface TabBarIcons {
	[routeName: string]: AppIcon;
}

/**
 * Structural subset of react-navigation's `BottomTabBarProps`. Declared here
 * because `@react-navigation/bottom-tabs` is a transitive expo-router
 * dependency and is not resolvable from this workspace.
 */
interface TabBarProps {
	state: {
		index: number;
		routes: Array<{ key: string; name: string }>;
	};
	descriptors: Record<
		string,
		{ options: { title?: string; href?: string | null } }
	>;
	navigation: {
		emit: (event: {
			type: "tabPress";
			target: string;
			canPreventDefault: true;
		}) => { defaultPrevented: boolean };
		navigate: (name: string) => void;
	};
}

/**
 * Flush bottom bar — hairline top border over a blurred canvas, not a floating
 * pill. Active state is accent icon + label with a short accent underline.
 */
export function createTabBar(icons: TabBarIcons) {
	return function TabBar({ state, descriptors, navigation }: TabBarProps) {
		const insets = useSafeAreaInsets();
		const { theme } = useUniwind();

		const visibleRoutes = state.routes.filter(
			(route) => descriptors[route.key]?.options.href !== null,
		);

		return (
			<View className="absolute right-0 bottom-0 left-0">
				<BlurView
					intensity={theme === "dark" ? 40 : 60}
					tint={theme === "dark" ? "dark" : "light"}
					className="border-border border-t"
				>
					<View
						className="flex-row bg-background/70"
						style={{
							height: layout.tabBarHeight + insets.bottom,
							paddingBottom: insets.bottom,
						}}
					>
						{visibleRoutes.map((route) => {
							const descriptor = descriptors[route.key];
							const isFocused = state.routes[state.index]?.key === route.key;
							const Icon = icons[route.name];
							const label = descriptor?.options.title ?? route.name;

							return (
								<Pressable
									key={route.key}
									accessibilityRole="button"
									accessibilityState={isFocused ? { selected: true } : {}}
									accessibilityLabel={label}
									onPress={() => {
										const event = navigation.emit({
											type: "tabPress",
											target: route.key,
											canPreventDefault: true,
										});
										if (!isFocused && !event.defaultPrevented) {
											navigation.navigate(route.name);
										}
									}}
									className="flex-1 items-center justify-center gap-1 pt-1.5"
								>
									{Icon ? (
										<Icon
											size={iconSize.bar}
											className={isFocused ? "text-accent" : "text-muted"}
										/>
									) : null}
									<Text
										numberOfLines={1}
										className={cn(
											"font-medium text-2xs",
											isFocused ? "text-accent" : "text-muted",
										)}
									>
										{label}
									</Text>
								</Pressable>
							);
						})}
					</View>
				</BlurView>
			</View>
		);
	};
}
