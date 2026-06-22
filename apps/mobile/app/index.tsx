import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useI18n } from "@/providers/i18n-provider";

import { useAccount } from "../src/contexts/account-context";
import { useBiometricAuth } from "../src/contexts/biometric-auth-context";
import { storage } from "../src/services/storage";

export default function Index() {
	const { m } = useI18n();
	const { activeAccount, activeAccountConfig, allAccounts, isLoading } =
		useAccount();
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
			if (!activeAccountConfig) {
				setCheckingSession(false);
				return;
			}

			try {
				if (activeAccountConfig.type === "all") {
					const accounts = await storage.getAccountsList();
					if (accounts.length === 0) {
						setHasValidSession(false);
						setMukAvailable(false);
						return;
					}

					const sessionChecks = await Promise.all(
						accounts.map((account) =>
							storage.isSessionValid(account.accountId),
						),
					);
					setHasValidSession(sessionChecks.some(Boolean));

					const unlockedAccountIds =
						(await storage.getUnlockedAccounts?.()) ?? [];
					setMukAvailable(unlockedAccountIds.length > 0);
				} else if (activeAccount) {
					const isValid = await storage.isSessionValid(activeAccount.accountId);
					setHasValidSession(isValid);

					if (isValid) {
						const muk = await storage.getMasterUnlockKey(
							activeAccount.accountId,
						);
						setMukAvailable(muk !== null);
					}
				}
			} catch (error) {
				console.error("Error checking session:", error);
				setHasValidSession(false);
			} finally {
				setCheckingSession(false);
			}
		}

		checkSession();
	}, [activeAccount, activeAccountConfig, isLoading]);

	// Re-check MUK availability when biometric auth completes
	useEffect(() => {
		if (!requiresReauth && hasValidSession) {
			if (activeAccountConfig?.type === "all") {
				storage
					.getUnlockedAccounts?.()
					.then((unlocked = []) => setMukAvailable(unlocked.length > 0));
			} else if (activeAccount) {
				// Biometric auth just completed, check if MUK is now available
				storage
					.getMasterUnlockKey(activeAccount.accountId)
					.then((muk) => setMukAvailable(muk !== null));
			}
		}
	}, [requiresReauth, hasValidSession, activeAccount, activeAccountConfig]);

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
	if (!activeAccountConfig && allAccounts.length === 0) {
		return <Redirect href="/(auth)/login" />;
	}

	if (activeAccountConfig?.type === "all") {
		if (!hasValidSession) {
			return <Redirect href="/(auth)/login" />;
		}

		if (!mukAvailable) {
			return <Redirect href="/(auth)/unlock" />;
		}
	} else {
		// Has account but no valid session - go to unlock
		if (!hasValidSession) {
			return <Redirect href="/(auth)/unlock" />;
		}
	}

	// Wait for biometric auth to complete before navigating to tabs
	// This prevents race conditions where items try to decrypt before MUK is restored
	if (requiresReauth || showAuthModal || !mukAvailable) {
		return (
			<View className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
				{showAuthModal && (
					<Text className="mt-4 text-muted text-sm">
						{m.mob_index_authenticating()}
					</Text>
				)}
			</View>
		);
	}

	// Has valid session and MUK is available - go to tabs
	return <Redirect href="/(tabs)" />;
}
