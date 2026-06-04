import "../global.css";
// Native crypto is provided by @bittery/crypto-nitro Expo module
// No polyfill setup needed - all crypto operations use native Rust code
// See apps/mobile/src/lib/crypto/ for the unified crypto API

import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { HeroUINativeProvider, useThemeColor } from "heroui-native";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import {
	SafeAreaListener,
	SafeAreaProvider,
} from "react-native-safe-area-context";
import { Uniwind } from "uniwind";
import { BiometricAuthModal } from "../src/components/biometric-auth-modal";
import { AccountProvider } from "../src/contexts/account-context";
import {
	BiometricAuthProvider,
	useBiometricAuth,
} from "../src/contexts/biometric-auth-context";
import { useCredentialProviderSync } from "../src/hooks/use-credential-provider-sync";
import { RpcProvider } from "../src/lib/rpc";
import { I18nProvider } from "../src/providers/i18n-provider";
import { MobilePlatformProvider } from "../src/providers/platform-provider";
import { storage } from "../src/services/storage";
import { loadThemePreference } from "../src/services/theme-storage";

// Initial theme will be loaded from storage during app initialization
Uniwind.setTheme("system");

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Inner component that has access to BiometricAuthContext
function AppContent() {
	const { showAuthModal, dismissAuthRequirement } = useBiometricAuth();
	const enableCredentialSync =
		Platform.OS === "android" &&
		process.env.EXPO_PUBLIC_DISABLE_ANDROID_CREDENTIAL_SYNC !== "true";

	// Keep Android credential-provider data in sync regardless of active route.
	useCredentialProviderSync({
		enabled: enableCredentialSync,
		autoSync: enableCredentialSync,
		debounceMs: __DEV__ ? 5000 : 3000,
	});

	const [background] = useThemeColor(["background"]);

	return (
		<SafeAreaListener
			onChange={({ insets }) => {
				Uniwind.updateInsets(insets);
			}}
		>
			<Stack
				screenOptions={{
					headerShown: false,
					contentStyle: { backgroundColor: background },
				}}
			>
				<Stack.Screen name="index" />
				<Stack.Screen name="(auth)" options={{ headerShown: false }} />
				<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
				<Stack.Screen name="(vault)" options={{ headerShown: false }} />
				<Stack.Screen name="settings" options={{ headerShown: false }} />
				<Stack.Screen
					name="autofill-unlock"
					options={{
						headerShown: false,
						presentation: "modal",
					}}
				/>
			</Stack>
			<BiometricAuthModal
				visible={showAuthModal}
				onSuccess={dismissAuthRequirement}
			/>
			<StatusBar style="auto" />
		</SafeAreaListener>
	);
}

export default function RootLayout() {
	const [appIsReady, setAppIsReady] = useState(false);

	useEffect(() => {
		async function prepare() {
			try {
				// Initialize storage adapter (loads Expo modules)
				await storage.initialize();

				// Load and apply saved theme preference
				const savedTheme = await loadThemePreference();
				Uniwind.setTheme(savedTheme);
			} catch (error) {
				console.error("[RootLayout] Failed to initialize storage:", error);
			} finally {
				setAppIsReady(true);
				await SplashScreen.hideAsync();
			}
		}

		prepare();
	}, []);

	if (!appIsReady) {
		return null;
	}

	return (
		<GestureHandlerRootView style={{ flex: 1 }}>
			<HeroUINativeProvider>
				<SafeAreaProvider>
					<RpcProvider>
						<I18nProvider>
							<MobilePlatformProvider>
								<AccountProvider>
									<BiometricAuthProvider>
										<AppContent />
									</BiometricAuthProvider>
								</AccountProvider>
							</MobilePlatformProvider>
						</I18nProvider>
					</RpcProvider>
				</SafeAreaProvider>
			</HeroUINativeProvider>
		</GestureHandlerRootView>
	);
}
