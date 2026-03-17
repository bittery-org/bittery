/**
 * Biometric Authentication Context
 * Handles app state changes and biometric re-authentication when returning from background
 */

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
	const { activeAccount, activeAccountConfig, allAccounts, isAllAccountsMode } =
		useAccount();
	const appState = useRef<AppStateStatus>(AppState.currentState);

	const [requiresReauth, setRequiresReauth] = useState(false);
	const [showAuthModal, setShowAuthModal] = useState(false);
	const [lastAuthResult, setLastAuthResult] =
		useState<BiometricAuthResult | null>(null);
	const [requiresMasterPassword, setRequiresMasterPassword] = useState(false);

	const setNativeMuksForAccounts = useCallback(async (emails: string[]) => {
		if (Platform.OS !== "android" || !CredentialProvider.isAvailable()) {
			return;
		}

		for (const email of emails) {
			const muk = await storage.getMasterUnlockKey(email);
			const sessionData = await storage.getStoredSessionData(email);
			const autoLockTimeoutMs =
				await storage.getAutoLockTimeoutOrDefault(email);
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
						`[BiometricAuth] setNativeMuksForAccounts skipped for ${email} (no muk or no userId)`,
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
				if (isAllAccountsMode) {
					await storage.storeBackgroundTimestampGlobal?.();
				} else if (activeAccount) {
					await storage.storeBackgroundTimestamp(activeAccount.email);
				}
			}

			// App is coming back to foreground
			if (
				(appState.current === "background" ||
					appState.current === "inactive") &&
				nextAppState === "active"
			) {
				// Check if re-authentication is required
				const shouldRequireAuth = isAllAccountsMode
					? await storage.shouldRequireAuthAfterBackgroundGlobal?.()
					: activeAccount
						? await storage.shouldRequireAuthAfterBackground(
								activeAccount.email,
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
						await storage.clearSession(activeAccount.email);
					}

					const accountEmails = allAccounts.map((account) => account.email);
					const fallbackEmail = accountEmails[0];

					// Check if biometric is enabled globally
					const biometricEnabled =
						await storage.isBiometricEnabled(fallbackEmail);
					const canUseBiometric = isAllAccountsMode
						? (
								await Promise.all(
									accountEmails.map((email) =>
										storage.canBiometricUnlock(email),
									),
								)
							).some(Boolean)
						: activeAccount
							? await storage.canBiometricUnlock(activeAccount.email)
							: false;

					if (biometricEnabled && canUseBiometric) {
						// Check if master password re-entry is required for any account
						const masterPasswordRequired = isAllAccountsMode
							? (
									await Promise.all(
										accountEmails.map((email) =>
											storage.isMasterPasswordReentryRequired(email),
										),
									)
								).some(Boolean)
							: activeAccount
								? await storage.isMasterPasswordReentryRequired(
										activeAccount.email,
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
				if (isAllAccountsMode) {
					await storage.clearBackgroundTimestampGlobal?.();
				} else if (activeAccount) {
					await storage.clearBackgroundTimestamp(activeAccount.email);
				}
			}

			appState.current = nextAppState;
		},
		[
			activeAccount,
			activeAccountConfig,
			allAccounts,
			isAllAccountsMode,
			router,
		],
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
			if (isAllAccountsMode) {
				if (!storage.unlockAllAccountsWithBiometric) {
					const result: BiometricAuthResult = {
						success: false,
						error: "not_available",
						message: "Biometric unlock is not available",
					};
					setLastAuthResult(result);
					return result;
				}

				const unlockResult = await storage.unlockAllAccountsWithBiometric();
				const success = unlockResult.unlocked.length > 0;
				const result: BiometricAuthResult = success
					? { success: true }
					: {
							success: false,
							error: "authentication_failed",
							message: "Biometric authentication failed",
						};

				if (success) {
					await setNativeMuksForAccounts(unlockResult.unlocked);
					setRequiresReauth(false);
					setShowAuthModal(false);
					setRequiresMasterPassword(false);
				}

				setLastAuthResult(result);
				return result;
			}

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
				// Restore MUK to memory after successful biometric auth
				// This ensures decryption queries can run immediately without polling
				try {
					const muk = await storage.decryptStoredMasterUnlockKeyPublic(
						activeAccount.email,
						true, // Skip biometric since we just authenticated
					);
					if (muk) {
						// Store in React Native memory cache
						await storage.storeMasterUnlockKey(muk, activeAccount.email);
						await setNativeMuksForAccounts([activeAccount.email]);
					} else {
						if (__DEV__) {
							console.warn(
								"[BiometricAuth] decryptStoredMasterUnlockKeyPublic returned null MUK",
							);
						}
					}
				} catch (error) {
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
		}, [activeAccount, isAllAccountsMode, setNativeMuksForAccounts]);

	// Check if re-auth is needed
	const checkAndRequireAuth = useCallback(async (): Promise<boolean> => {
		if (!activeAccountConfig) return false;

		const accountEmails = allAccounts.map((account) => account.email);

		if (isAllAccountsMode) {
			const sessionResults = await Promise.all(
				accountEmails.map((email) => storage.isSessionValid(email)),
			);
			const anySessionValid = sessionResults.some(Boolean);
			if (!anySessionValid) {
				router.replace("/(auth)/unlock");
				return true;
			}

			const biometricRequiredResults = await Promise.all(
				accountEmails.map((email) =>
					storage.isBiometricAuthRequiredPublic?.(email),
				),
			);
			const biometricRequired = biometricRequiredResults.some(Boolean);

			if (biometricRequired) {
				const canUseBiometric = (
					await Promise.all(
						accountEmails.map((email) => storage.canBiometricUnlock(email)),
					)
				).some(Boolean);

				if (canUseBiometric) {
					setRequiresReauth(true);
					setShowAuthModal(true);
					return true;
				}
			}

			const masterPasswordRequired = (
				await Promise.all(
					accountEmails.map((email) =>
						storage.isMasterPasswordReentryRequired(email),
					),
				)
			).some(Boolean);

			if (masterPasswordRequired) {
				setRequiresMasterPassword(true);
				setRequiresReauth(true);
				router.replace("/(auth)/unlock");
				return true;
			}

			return false;
		}

		if (!activeAccount) return false;

		// Check session validity
		const sessionValid = await storage.isSessionValid(activeAccount.email);
		if (!sessionValid) {
			router.replace("/(auth)/unlock");
			return true;
		}

		// Check biometric auth requirement
		const biometricRequired = await storage.isBiometricAuthRequiredPublic(
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
	}, [
		activeAccount,
		activeAccountConfig,
		allAccounts,
		isAllAccountsMode,
		router,
	]);

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
