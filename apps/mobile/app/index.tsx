import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { useAccount } from "../src/contexts/account-context";
import * as storage from "../src/services/storage";

export default function Index() {
	const { activeAccount, isLoading } = useAccount();
	const [checkingSession, setCheckingSession] = useState(true);
	const [hasValidSession, setHasValidSession] = useState(false);

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
			} catch (error) {
				console.error("Error checking session:", error);
				setHasValidSession(false);
			} finally {
				setCheckingSession(false);
			}
		}

		checkSession();
	}, [activeAccount, isLoading]);

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

	// Has valid session - go to vault
	return <Redirect href="/(vault)" />;
}
