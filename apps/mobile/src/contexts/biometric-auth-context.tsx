/**
 * Biometric Authentication Context
 * Handles app state changes and biometric re-authentication when returning from background
 */

import { createStoredAccountRpcClient } from "@bittery/core/services/account-resolver";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import { useRouter } from "expo-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import CredentialProvider from "../../modules/credential-provider";
import { type BiometricAuthResult, storage } from "../services/storage";
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
	const { activeAccount, activeAccountConfig, allAccounts } = useAccount();
	const appState = useRef<AppStateStatus>(AppState.currentState);

	const [requiresReauth, setRequiresReauth] = useState(false);
	const [showAuthModal, setShowAuthModal] = useState(false);
	const [lastAuthResult, setLastAuthResult] =
		useState<BiometricAuthResult | null>(null);
	const [requiresMasterPassword, setRequiresMasterPassword] = useState(false);

	const setNativeMuksForAccounts = useCallback(async (accountIds: string[]) => {
		if (Platform.OS !== "android" || !CredentialProvider.isAvailable()) {
			return;
		}

		for (const accountId of accountIds) {
			const muk = await storage.getMasterUnlockKey(accountId);
			const sessionData = await storage.getStoredSessionData(accountId);
			const autoLockTimeoutMs =
				await storage.getAutoLockTimeoutOrDefault(accountId);
			if (muk && sessionData?.userId) {
				const mukBase64 = arrayBufferToBase64(muk);
				CredentialProvider.setMasterUnlockKey(
					mukBase64,
					sessionData.userId,
					autoLockTimeoutMs,
				);
			} else {
				if (__DEV__) {
					console.warn(
						`[BiometricAuth] setNativeMuksForAccounts skipped for ${accountId} (no muk or no userId)`,
					);
				}
			}
		}
	}, []);

	// Track background timestamp when app goes to background
	const handleAppStateChange = useCallback(
		async (nextAppState: AppStateStatus) => {
			if (!activeAccountConfig) return;

			// App is going to background
			if (
				appState.current === "active" &&
				(nextAppState === "background" || nextAppState === "inactive")
			) {
				if (activeAccount) {
					await storage.storeBackgroundTimestamp(activeAccount.accountId);
				}
			}

			// App is coming back to foreground
			if (
				(appState.current === "background" ||
					appState.current === "inactive") &&
				nextAppState === "active"
			) {
				// Check if re-authentication is required
				const shouldRequireAuth = activeAccount
					? await storage.shouldRequireAuthAfterBackground(
							activeAccount.accountId,
						)
					: false;

				if (shouldRequireAuth) {
					// IMPORTANT: Clear MUK from native VaultStateManager when auto-lock triggers
					// This prevents autofill from working while app is locked
					if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
						CredentialProvider.clearAllMasterUnlockKeys();
					}

					if (storage.lockAllAccounts) {
						await storage.lockAllAccounts();
					} else if (activeAccount) {
						await storage.clearSession(activeAccount.accountId);
					}

					const fallbackAccountId =
						activeAccount?.accountId ?? allAccounts[0]?.accountId;

					// Check if biometric is enabled globally
					const biometricEnabled = fallbackAccountId
						? await storage.isBiometricEnabled(fallbackAccountId)
						: false;
					const canUseBiometric = activeAccount
						? await storage.canBiometricUnlock(activeAccount.accountId)
						: false;

					if (biometricEnabled && canUseBiometric) {
						// Check if master password re-entry is required
						const masterPasswordRequired = activeAccount
							? await storage.isMasterPasswordReentryRequired(
									activeAccount.accountId,
								)
							: false;

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
				if (activeAccount) {
					await storage.clearBackgroundTimestamp(activeAccount.accountId);
				}
			}

			appState.current = nextAppState;
		},
		[activeAccount, activeAccountConfig, allAccounts, router],
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
	const triggerBiometricAuth =
		useCallback(async (): Promise<BiometricAuthResult> => {
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
				activeAccount.accountId,
			);

			setLastAuthResult(result);

			if (result.success) {
				const accountId = activeAccount.accountId;
				// Restore MUK to memory after successful biometric auth
				// This ensures decryption queries can run immediately without polling
				try {
					const client = await createStoredAccountRpcClient(
						storage,
						accountId,
					).catch(() => null);
					await getTravelModeEnforcer(storage).verifyForUnlock(
						accountId,
						client,
					);
					const muk = await storage.decryptStoredMasterUnlockKeyPublic(
						accountId,
						true, // Skip biometric since we just authenticated
					);
					if (muk) {
						// Store in React Native memory cache
						await storage.storeMasterUnlockKey(muk, accountId);
						await setNativeMuksForAccounts([accountId]);
					} else {
						if (__DEV__) {
							console.warn(
								"[BiometricAuth] decryptStoredMasterUnlockKeyPublic returned null MUK",
							);
						}
					}
				} catch (error) {
					await storage.clearSession(accountId);
					console.error(
						"[BiometricAuth] Failed to restore MUK after biometric auth:",
						error,
					);
				}

				setRequiresReauth(false);
				setShowAuthModal(false);
				setRequiresMasterPassword(false);
			} else if (result.error === "master_password_required") {
				setRequiresMasterPassword(true);
			}

			return result;
		}, [activeAccount, setNativeMuksForAccounts]);

	// Check if re-auth is needed
	const checkAndRequireAuth = useCallback(async (): Promise<boolean> => {
		if (!activeAccountConfig) return false;

		if (!activeAccount) return false;

		// Check session validity
		const sessionValid = await storage.isSessionValid(activeAccount.accountId);
		if (!sessionValid) {
			router.replace("/(auth)/unlock");
			return true;
		}

		// Check biometric auth requirement
		const biometricRequired = await storage.isBiometricAuthRequiredPublic(
			activeAccount.accountId,
		);

		if (biometricRequired) {
			const canUseBiometric = await storage.canBiometricUnlock(
				activeAccount.accountId,
			);
			if (canUseBiometric) {
				setRequiresReauth(true);
				setShowAuthModal(true);
				return true;
			}
		}

		// Check master password re-entry requirement
		const masterPasswordRequired =
			await storage.isMasterPasswordReentryRequired(activeAccount.accountId);

		if (masterPasswordRequired) {
			setRequiresMasterPassword(true);
			setRequiresReauth(true);
			router.replace("/(auth)/unlock");
			return true;
		}

		return false;
	}, [activeAccount, activeAccountConfig, router]);

	// Dismiss auth requirement
	const dismissAuthRequirement = useCallback(() => {
		setRequiresReauth(false);
		setShowAuthModal(false);
		setLastAuthResult(null);
		setRequiresMasterPassword(false);
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
