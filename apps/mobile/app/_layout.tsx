import "../src/global.css";
import { install as installQuickCrypto } from "react-native-quick-crypto";

// Install crypto polyfill before any other imports that might use crypto
installQuickCrypto();

import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AccountProvider } from "../src/contexts/account-context";
import { OfflineVaultProvider } from "../src/contexts/offline-vault-context";
import { TRPCProvider } from "../src/lib/trpc";
import { OfflineModeBanner } from "../src/components/sync-status-indicator";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
	const [appIsReady, setAppIsReady] = useState(false);

	useEffect(() => {
		async function prepare() {
			// Add any initialization logic here
			// e.g., load fonts, check auth state, etc.
			setAppIsReady(true);
			await SplashScreen.hideAsync();
		}

		prepare();
	}, []);

	if (!appIsReady) {
		return null;
	}

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<SafeAreaProvider>
				<TRPCProvider>
					<AccountProvider>
						<OfflineVaultProvider>
							<OfflineModeBanner />
							<Stack
								screenOptions={{
									headerShown: false,
									contentStyle: { backgroundColor: "#ffffff" },
								}}
							>
								<Stack.Screen name="index" />
								<Stack.Screen name="(auth)" options={{ headerShown: false }} />
								<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
								<Stack.Screen name="(vault)" options={{ headerShown: false }} />
								<Stack.Screen name="(tag)" options={{ headerShown: false }} />
								<Stack.Screen name="settings" options={{ headerShown: false }} />
							</Stack>
							<StatusBar style="auto" />
						</OfflineVaultProvider>
					</AccountProvider>
				</TRPCProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
