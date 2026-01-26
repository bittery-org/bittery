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
import { OfflineModeBanner } from "../src/components/sync-status-indicator";
import { AccountProvider } from "../src/contexts/account-context";
import {
	BiometricAuthProvider,
	useBiometricAuth,
} from "../src/contexts/biometric-auth-context";
import { OfflineVaultProvider } from "../src/contexts/offline-vault-context";
import { TRPCProvider } from "../src/lib/trpc";
import { MobilePlatformProvider } from "../src/providers/platform-provider";

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// Inner component that has access to BiometricAuthContext
function AppContent() {
	const { showAuthModal, dismissAuthRequirement } = useBiometricAuth();

	return (
		<>
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
				<Stack.Screen name="settings" options={{ headerShown: false }} />
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
					<MobilePlatformProvider>
						<AccountProvider>
							<OfflineVaultProvider>
								<BiometricAuthProvider>
									<AppContent />
								</BiometricAuthProvider>
							</OfflineVaultProvider>
						</AccountProvider>
					</MobilePlatformProvider>
				</TRPCProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
