/**
 * Biometric Authentication Context
 * Handles app state changes and biometric re-authentication when returning from background
 */

import type { BiometricAuthResult } from "@bittery/crypto/storage-react-native";
import { useRouter } from "expo-router";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";

import * as storage from "../services/storage";
import { useAccount } from "./account-context";

interface BiometricAuthContextValue {
	// Whether biometric re-auth is required
	requiresReauth: boolean;
	// Whether the auth modal is visible
	showAuthModal: boolean;
	// Last authentication result
	lastAuthResult: BiometricAuthResult | null;
	// Trigger biometric authentication
	triggerBiometricAuth: () => Promise<BiometricAuthResult>;
	// Check and potentially require re-auth
	checkAndRequireAuth: () => Promise<boolean>;
	// Dismiss the auth requirement (for navigation to unlock screen)
	dismissAuthRequirement: () => void;
	// Whether master password is required (30-day re-entry)
	requiresMasterPassword: boolean;
}

const BiometricAuthContext = createContext<BiometricAuthContextValue | null>(
	null,
);

export function BiometricAuthProvider({ children }: { children: ReactNode }) {
	const router = useRouter();
	const { activeAccount } = useAccount();
	const appState = useRef<AppStateStatus>(AppState.currentState);

	const [requiresReauth, setRequiresReauth] = useState(false);
	const [showAuthModal, setShowAuthModal] = useState(false);
	const [lastAuthResult, setLastAuthResult] =
		useState<BiometricAuthResult | null>(null);
	const [requiresMasterPassword, setRequiresMasterPassword] = useState(false);

	// Track background timestamp when app goes to background
	const handleAppStateChange = useCallback(
		async (nextAppState: AppStateStatus) => {
			if (!activeAccount) return;

			// App is going to background
			if (
				appState.current === "active" &&
				(nextAppState === "background" || nextAppState === "inactive")
			) {
				await storage.storeBackgroundTimestamp(activeAccount.email);
			}

			// App is coming back to foreground
			if (
				(appState.current === "background" ||
					appState.current === "inactive") &&
				nextAppState === "active"
			) {
				// Check if re-authentication is required
				const shouldRequireAuth =
					await storage.shouldRequireAuthAfterBackground(activeAccount.email);

				if (shouldRequireAuth) {
					// Check if biometric is enabled for this account
					const biometricEnabled = await storage.isBiometricEnabled(
						activeAccount.email,
					);
					const canUseBiometric = await storage.canBiometricUnlock(
						activeAccount.email,
					);

					if (biometricEnabled && canUseBiometric) {
						// Check if master password re-entry is required
						const masterPasswordRequired =
							await storage.isMasterPasswordReentryRequired(activeAccount.email);

						if (masterPasswordRequired) {
							setRequiresMasterPassword(true);
							setRequiresReauth(true);
							// Navigate to unlock screen for password entry
							router.replace("/(auth)/unlock");
						} else {
							// Trigger biometric re-authentication
							setRequiresReauth(true);
							setShowAuthModal(true);
						}
					} else {
						// No biometric available, navigate to unlock screen
						setRequiresReauth(true);
						router.replace("/(auth)/unlock");
					}
				}

				// Clear background timestamp after handling
				await storage.clearBackgroundTimestamp(activeAccount.email);
			}

			appState.current = nextAppState;
		},
		[activeAccount, router],
	);

	// Set up app state listener
	useEffect(() => {
		const subscription = AppState.addEventListener(
			"change",
			handleAppStateChange,
		);

		return () => {
			subscription.remove();
		};
	}, [handleAppStateChange]);

	// Trigger biometric authentication
	const triggerBiometricAuth = useCallback(async (): Promise<BiometricAuthResult> => {
		if (!activeAccount) {
			const result: BiometricAuthResult = {
				success: false,
				error: "unknown",
				message: "No active account",
			};
			setLastAuthResult(result);
			return result;
		}

		const result = await storage.authenticateWithBiometricEnhanced(
			"Unlock Bittery",
			activeAccount.email,
		);

		setLastAuthResult(result);

		if (result.success) {
			setRequiresReauth(false);
			setShowAuthModal(false);
			setRequiresMasterPassword(false);
		} else if (result.error === "master_password_required") {
			setRequiresMasterPassword(true);
		}

		return result;
	}, [activeAccount]);

	// Check if re-auth is needed
	const checkAndRequireAuth = useCallback(async (): Promise<boolean> => {
		if (!activeAccount) return false;

		// Check session validity
		const sessionValid = await storage.isSessionValid(activeAccount.email);
		if (!sessionValid) {
			router.replace("/(auth)/unlock");
			return true;
		}

		// Check biometric auth requirement
		const biometricRequired = await storage.isBiometricAuthRequired(
			activeAccount.email,
		);

		if (biometricRequired) {
			const canUseBiometric = await storage.canBiometricUnlock(
				activeAccount.email,
			);
			if (canUseBiometric) {
				setRequiresReauth(true);
				setShowAuthModal(true);
				return true;
			}
		}

		// Check master password re-entry requirement
		const masterPasswordRequired =
			await storage.isMasterPasswordReentryRequired(activeAccount.email);

		if (masterPasswordRequired) {
			setRequiresMasterPassword(true);
			setRequiresReauth(true);
			router.replace("/(auth)/unlock");
			return true;
		}

		return false;
	}, [activeAccount, router]);

	// Dismiss auth requirement
	const dismissAuthRequirement = useCallback(() => {
		setRequiresReauth(false);
		setShowAuthModal(false);
		setLastAuthResult(null);
	}, []);

	return (
		<BiometricAuthContext.Provider
			value={{
				requiresReauth,
				showAuthModal,
				lastAuthResult,
				triggerBiometricAuth,
				checkAndRequireAuth,
				dismissAuthRequirement,
				requiresMasterPassword,
			}}
		>
			{children}
		</BiometricAuthContext.Provider>
	);
}

export function useBiometricAuth() {
	const context = useContext(BiometricAuthContext);
	if (!context) {
		throw new Error(
			"useBiometricAuth must be used within a BiometricAuthProvider",
		);
	}
	return context;
}
