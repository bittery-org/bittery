import "../src/global.css";
import { install as installQuickCrypto } from "react-native-quick-crypto";
import crypto from "react-native-quick-crypto";
import { setCryptoProvider, type HashAlgorithm } from "@bittery/srp6a";

// Install crypto polyfill before any other imports that might use crypto
installQuickCrypto();

// Set up native crypto provider for SRP6a (uses native PBKDF2 instead of JS)
setCryptoProvider({
	getRandomValues: (array: Uint8Array) => {
		crypto.getRandomValues(array);
	},
	digest: async (algorithm: HashAlgorithm, data: ArrayBuffer) => {
		const hashName = algorithm.replace("-", "").toLowerCase(); // "SHA-256" -> "sha256"
		const hash = crypto.createHash(hashName);
		hash.update(Buffer.from(data));
		return hash.digest().buffer as ArrayBuffer;
	},
	deriveKeyWithPBKDF2: async (
		algorithm: HashAlgorithm,
		salt: ArrayBuffer,
		password: string,
		iterations = 100000,
	) => {
		const hashName = algorithm.replace("-", "").toLowerCase();
		return new Promise<ArrayBuffer>((resolve, reject) => {
			crypto.pbkdf2(
				password,
				Buffer.from(salt),
				iterations,
				32, // 256 bits
				hashName,
				(err, derivedKey) => {
					if (err) reject(err);
					else resolve(derivedKey.buffer as ArrayBuffer);
				},
			);
		});
	},
});

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
					<AccountProvider>
						<OfflineVaultProvider>
							<BiometricAuthProvider>
								<AppContent />
							</BiometricAuthProvider>
						</OfflineVaultProvider>
					</AccountProvider>
				</TRPCProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
