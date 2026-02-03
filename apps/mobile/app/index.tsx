import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { useAccount } from "../src/contexts/account-context";
import { useBiometricAuth } from "../src/contexts/biometric-auth-context";
import { storage } from "../src/services/storage";

export default function Index() {
	const { activeAccount, isLoading } = useAccount();
	const { requiresReauth, showAuthModal } = useBiometricAuth();
	const [checkingSession, setCheckingSession] = useState(true);
	const [hasValidSession, setHasValidSession] = useState(false);
	const [mukAvailable, setMukAvailable] = useState(false);

	useEffect(() => {
		// Don't check session until account loading is complete
		if (isLoading) {
			return;
		}

		async function checkSession() {
			if (!activeAccount) {
				setCheckingSession(false);
				return;
			}

			try {
				const isValid = await storage.isSessionValid(activeAccount.email);
				setHasValidSession(isValid);

				// If session is valid, check if MUK is available
				if (isValid) {
					const muk = await storage.getMasterUnlockKey(activeAccount.email);
					setMukAvailable(muk !== null);
				}
			} catch (error) {
				console.error("Error checking session:", error);
				setHasValidSession(false);
			} finally {
				setCheckingSession(false);
			}
		}

		checkSession();
	}, [activeAccount, isLoading]);

	// Re-check MUK availability when biometric auth completes
	useEffect(() => {
		if (!requiresReauth && hasValidSession && activeAccount) {
			// Biometric auth just completed, check if MUK is now available
			storage
				.getMasterUnlockKey(activeAccount.email)
				.then((muk) => setMukAvailable(muk !== null));
		}
	}, [requiresReauth, hasValidSession, activeAccount]);

	// Only show loading while account context is loading
	// Once that's done, checkingSession should resolve quickly
	if (isLoading || checkingSession) {
		return (
			<View className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
			</View>
		);
	}

	// No accounts - go to login
	if (!activeAccount) {
		return <Redirect href="/(auth)/login" />;
	}

	// Has account but no valid session - go to unlock
	if (!hasValidSession) {
		return <Redirect href="/(auth)/unlock" />;
	}

	// Wait for biometric auth to complete before navigating to tabs
	// This prevents race conditions where items try to decrypt before MUK is restored
	if (requiresReauth || showAuthModal || !mukAvailable) {
		return (
			<View className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
				{showAuthModal && (
					<Text className="mt-4 text-muted text-sm">
						Authenticating...
					</Text>
				)}
			</View>
		);
	}

	// Has valid session and MUK is available - go to tabs
	return <Redirect href="/(tabs)" />;
}
