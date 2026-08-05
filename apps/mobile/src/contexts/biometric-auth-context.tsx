/**
 * Biometric Authentication Context
 * Handles app state changes and biometric re-authentication when returning from background
 */

import { createMobileAutolockService } from "@bittery/core/hooks/services/autolock-mobile";
import {
	lockAccount,
	lockAllAccounts,
} from "@bittery/core/services/account-lifecycle";
import { createStoredAccountRpcClient } from "@bittery/core/services/account-resolver";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import { useRouter } from "expo-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import { crypto } from "../lib/crypto";
import { useI18n } from "../providers/i18n-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "../services/credential-provider-master-unlock-key";
import { lifecycleDeps } from "../services/lifecycle";
import {
	type BiometricAuthResult,
	itemCache,
	storage,
} from "../services/storage";
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
	const { m } = useI18n();
	const { activeAccount, activeAccountConfig, allAccounts } = useAccount();
	const appState = useRef<AppStateStatus>(AppState.currentState);

	const [requiresReauth, setRequiresReauth] = useState(false);
	const [showAuthModal, setShowAuthModal] = useState(false);
	const [lastAuthResult, setLastAuthResult] =
		useState<BiometricAuthResult | null>(null);
	const [requiresMasterPassword, setRequiresMasterPassword] = useState(false);

	// Deciding whether time spent in the background has exceeded the auto-lock timeout is
	// autolock *policy*, and it lives in `@bittery/core`'s mobile autolock service.
	// `AccountStore` only supplies the two facts it is built from
	// (`getBackgroundTimestamp`, `getAutoLockTimeoutOrDefault`).
	//
	// The service is used purely as that policy oracle — `initialize()` is deliberately
	// never called, because this context owns the `AppState` subscription and the
	// lock/navigate/prompt sequence below. Initializing it would install a second listener
	// that wrote its own background timestamps and locked behind this one's back.
	const activeAccountIdRef = useRef<string | undefined>(undefined);
	activeAccountIdRef.current = activeAccount?.accountId;
	const autolockPolicy = useMemo(
		() =>
			createMobileAutolockService({
				storage,
				getActiveAccountId: async () => activeAccountIdRef.current,
			}),
		[],
	);

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
					? await autolockPolicy.shouldLock()
					: false;

				if (shouldRequireAuth) {
					// The native autofill mirror is purged inside this call, before the store
					// lock, so autofill cannot serve credentials while the app says locked.
					await lockAllAccounts(lifecycleDeps);

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
		[activeAccount, activeAccountConfig, allAccounts, autolockPolicy, router],
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

			// The prompt reason is rendered by the OS dialog, so it is user-facing copy and
			// has to arrive here already translated — storage will not author any.
			const result = await storage.authenticateWithBiometricEnhanced(
				m.biometric_prompt_unlock_bittery(),
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
					const verified = await getTravelModeEnforcer(
						storage,
						itemCache,
					).verifyOrClear(accountId, client);
					if (verified) {
						const muk = await storage.decryptStoredMasterUnlockKey(
							accountId,
							true, // Skip biometric since we just authenticated
						);
						if (muk) {
							let owner: "caller" | "storage" = "caller";
							try {
								await storage.setMasterUnlockKey(muk, accountId);
								owner = "storage";
								await mirrorBorrowedMasterUnlockKeysToCredentialProvider([
									accountId,
								]);
							} finally {
								if (owner === "caller") {
									await crypto.destroyKey(muk);
								}
							}
						} else {
							if (__DEV__) {
								console.warn(
									"[BiometricAuth] decryptStoredMasterUnlockKey returned null MUK",
								);
							}
						}
					}
				} catch (error) {
					// The MUK restore failed halfway, so drop back to a clean locked account
					// rather than leaving a half-unlocked one behind.
					await lockAccount(accountId, lifecycleDeps);
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
		}, [activeAccount, m.biometric_prompt_unlock_bittery]);

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

		// The biometric grace period is `AccountStore`'s own business, applied inside
		// `decryptStoredMasterUnlockKey`. What this screen needs is simpler: is the account
		// currently unlocked? `getUnlockedAccounts()` means exactly "the master unlock key
		// is in memory", so an account missing from it needs to be unlocked again.
		const unlockedAccountIds = await storage.getUnlockedAccounts();
		const biometricRequired = !unlockedAccountIds.includes(
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
