import "../src/global.css";
// Native crypto is provided by @bittery/crypto-nitro Expo module
// No polyfill setup needed - all crypto operations use native Rust code
// See apps/mobile/src/lib/crypto/ for the unified crypto API

import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BiometricAuthModal } from "../src/components/biometric-auth-modal";
import { AccountProvider } from "../src/contexts/account-context";
import {
	BiometricAuthProvider,
	useBiometricAuth,
} from "../src/contexts/biometric-auth-context";
import { TRPCProvider } from "../src/lib/trpc";
import { MobilePlatformProvider } from "../src/providers/platform-provider";
import { storage } from "../src/services/storage";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Inner component that has access to BiometricAuthContext
function AppContent() {
	const { showAuthModal, dismissAuthRequirement } = useBiometricAuth();

	return (
		<>
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
		</>
	);
}

export default function RootLayout() {
	const [appIsReady, setAppIsReady] = useState(false);

	useEffect(() => {
		async function prepare() {
			try {
				// Initialize storage adapter (loads Expo modules)
				await storage.initialize();
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
			<SafeAreaProvider>
				<TRPCProvider>
					<MobilePlatformProvider>
						<AccountProvider>
							<BiometricAuthProvider>
								<AppContent />
							</BiometricAuthProvider>
						</AccountProvider>
					</MobilePlatformProvider>
				</TRPCProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
