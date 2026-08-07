import {
	useBiometricUnlock,
	useQuickUnlock,
	useSessionState,
} from "@bittery/core/hooks";
import { removeAccount } from "@bittery/core/services/account-lifecycle";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, PressableFeedback } from "heroui-native";
import { useState } from "react";
import {
	Alert,
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	View,
} from "react-native";
import {
	AuthDivider,
	BiometricGlyph,
	InlineNotice,
	PasswordField,
	UnlockLockup,
} from "@/components/auth-kit";
import {
	AppBar,
	BrandButton,
	IconAlertCircle,
	IconKeyRound,
	IconLock,
	IconShieldCheck,
	IconX,
	iconSize,
	layout,
	Screen,
	SheetBrandAccent,
	useBottomInset,
} from "@/components/ui";
import { useAccount } from "@/contexts/account-context";
import { resolveBiometricErrorMessage } from "@/lib/biometric-error-message";
import { useBiometricType } from "@/lib/biometric-type";
import { useServerUrl } from "@/lib/rpc";
import { useI18n } from "@/providers/i18n-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/services/credential-provider-master-unlock-key";
import { lifecycleDeps } from "@/services/lifecycle";
import { storage } from "@/services/storage";
import CredentialProvider from "../modules/credential-provider";

/**
 * Autofill Unlock Screen
 *
 * This screen is launched from Android's Credential Provider Service when:
 * 1. User taps "Unlock Bittery" from autofill suggestions
 * 2. 30-day master password re-entry is required
 * 3. No biometric escrow is available
 *
 * Deep link format: bittery://autofill-unlock?passwordRequired={true|false}
 */
export default function AutofillUnlockScreen() {
	const router = useRouter();
	const { m } = useI18n();
	const params = useLocalSearchParams<{
		passwordRequired?: string;
	}>();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { activeAccount, allAccounts, refreshAccounts } = useAccount();
	const bottomInset = useBottomInset();

	const [password, setPassword] = useState("");
	const [biometricError, setBiometricError] = useState<string | null>(null);

	// Parse password required flag from deep link
	const passwordRequired = params.passwordRequired === "true";

	// Get session state for the active account
	const { data: sessionState, refetch: refetchSessionState } = useSessionState(
		activeAccount?.accountId,
		{ enabled: !!activeAccount },
	);
	const { label: biometricTypeLabel, token: biometricTypeToken } =
		useBiometricType({ enabled: !!activeAccount });

	const closeScreen = () => {
		// Close this screen - user can now use autofill
		if (router.canGoBack()) {
			router.back();
		} else {
			router.replace("/(vault)");
		}
	};

	const announceUnlocked = () => {
		Alert.alert(
			m.mob_autofill_unlock_alert_unlocked_title(),
			m.mob_autofill_unlock_alert_unlocked_message(),
			[{ text: m.mob_autofill_unlock_alert_ok(), onPress: closeScreen }],
		);
	};

	// Biometric unlock hook
	const biometricUnlock = useBiometricUnlock({
		// The OS renders this string, so it is user-facing copy and has to be
		// translated here rather than authored inside the hook.
		promptMessage: m.biometric_prompt_unlock_bittery(),
		onSuccess: async () => {
			if (!activeAccount) return;

			// Restore auth token and vault keys
			const token = await storage.getAuthToken(activeAccount.accountId);
			const vaultKeys = await storage.getVaultKeys(activeAccount.accountId);

			if (token && vaultKeys) {
				await mirrorBorrowedMasterUnlockKeysToCredentialProvider([
					activeAccount.accountId,
				]);

				// Load server URL for this account
				const serverUrl = await storage.getServerUrl(activeAccount.accountId);
				if (serverUrl) {
					setGlobalServerUrl(serverUrl);
				}

				await refreshAccounts();

				announceUnlocked();
			} else {
				Alert.alert(
					m.mob_unlock_alert_session_expired_title(),
					m.mob_unlock_alert_session_expired_message(),
				);
				// The stored session is unusable, so the account goes off the device
				// entirely — removal sequences the store, the item cache and the native
				// autofill mirror together.
				await removeAccount(activeAccount.accountId, lifecycleDeps);
				router.replace("/(auth)/login");
			}
		},
		onError: (error) => {
			// The period only rides along with `master_password_required`, and without it
			// the copy falls back to the variant that cannot name the interval.
			const errorMessage = resolveBiometricErrorMessage(
				{
					error: error.type,
					masterPasswordReentryPeriodMs: error.masterPasswordReentryPeriodMs,
				},
				m,
			);

			if (error.type === "master_password_required") {
				setBiometricError(errorMessage);
				// Refetch session state to update requiresPasswordReentry
				refetchSessionState();
			} else if (error.type === "lockout") {
				setBiometricError(errorMessage);
			} else if (error.type === "user_cancelled") {
				// User cancelled, don't show error
			} else {
				setBiometricError(errorMessage);
			}
		},
	});

	// Quick unlock (password) hook
	const quickUnlock = useQuickUnlock({
		onSuccess: async () => {
			if (!activeAccount) return;

			// Load server URL for this account
			const serverUrl = await storage.getServerUrl(activeAccount.accountId);
			if (serverUrl) {
				setGlobalServerUrl(serverUrl);
			}

			// Set MUK in native CredentialProvider for autofill decryption
			if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
				await mirrorBorrowedMasterUnlockKeysToCredentialProvider([
					activeAccount.accountId,
				]);

				// Update 30-day master password entry timestamp in native
				CredentialProvider.updateLastMasterPasswordEntry();

				// Escrow MUK with biometric for future quick unlocks
				const biometricAvailable = await storage.isBiometricAvailable();
				const biometricEnabled = await storage.isBiometricEnabled(
					activeAccount.accountId,
				);
				if (biometricAvailable && biometricEnabled) {
					// The escrow has to name the same id the native provider was keyed with
					// above: the session's userId, not the account record's.
					const sessionData = await storage.getStoredSessionData(
						activeAccount.accountId,
					);
					if (sessionData?.userId) {
						try {
							await CredentialProvider.escrowMukWithBiometric({
								email: activeAccount.email,
								userId: sessionData.userId,
							});
						} catch (escrowError) {
							// Escrow is optional, don't fail the unlock
							console.warn("Failed to escrow MUK with biometric:", escrowError);
						}
					}
				}
			}

			// Refresh account context
			await refreshAccounts();

			announceUnlocked();
		},
		onError: (error) => {
			console.error("Unlock error:", error);
			Alert.alert(
				m.mob_unlock_alert_error_title(),
				error instanceof Error
					? error.message
					: m.mob_unlock_alert_error_unlock_failed(),
			);
		},
	});

	const handleBiometricUnlock = async () => {
		if (!activeAccount) return;

		// Check if master password is required first (UI-level check for immediate feedback)
		if (sessionState?.requiresPasswordReentry || passwordRequired) {
			setBiometricError(m.mob_unlock_password_required_description());
			return;
		}

		setBiometricError(null);
		biometricUnlock.mutate({ accountId: activeAccount.accountId });
	};

	const handlePasswordUnlock = async () => {
		if (!activeAccount || !password.trim()) {
			Alert.alert(
				m.mob_unlock_alert_error_title(),
				m.mob_unlock_alert_error_enter_password(),
			);
			return;
		}

		setBiometricError(null);

		// Load server URL for this account before making the request
		const serverUrl = await storage.getServerUrl(activeAccount.accountId);
		if (serverUrl) {
			setGlobalServerUrl(serverUrl);
		}

		quickUnlock.mutate({
			accountId: activeAccount.accountId,
			password,
		});
	};

	// If no accounts, redirect to login
	if (!activeAccount || allAccounts.length === 0) {
		router.replace("/(auth)/login");
		return null;
	}

	const loading = biometricUnlock.isPending || quickUnlock.isPending;
	const requiresPasswordReentry =
		passwordRequired || sessionState?.requiresPasswordReentry || false;
	const canUseBiometric =
		sessionState?.canBiometricUnlock && !requiresPasswordReentry;

	return (
		<Screen surface="overlay">
			<SheetBrandAccent />
			<AppBar
				actions={
					<PressableFeedback
						onPress={closeScreen}
						accessibilityRole="button"
						accessibilityLabel={m.mob_settings_cancel()}
						className="-mr-2 h-9 w-9 items-center justify-center rounded-full"
					>
						<PressableFeedback.Highlight />
						<IconX size={iconSize.bar} className="text-muted" />
					</PressableFeedback>
				}
			/>
			<KeyboardAvoidingView
				className="flex-1"
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<ScrollView
					className="flex-1"
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="interactive"
					showsVerticalScrollIndicator={false}
					contentContainerStyle={{
						flexGrow: 1,
						justifyContent: "center",
						paddingHorizontal: layout.screenPadding,
						paddingBottom: bottomInset,
					}}
				>
					<UnlockLockup
						compact
						icon={IconShieldCheck}
						title={m.mob_autofill_unlock_title()}
						subtitle={activeAccount.email}
					/>

					<View className="mt-7 gap-4">
						{requiresPasswordReentry ? (
							<InlineNotice
								tone="warning"
								icon={IconKeyRound}
								title={m.mob_unlock_password_required_title()}
								description={m.mob_unlock_password_required_description()}
							/>
						) : null}

						{biometricError && !requiresPasswordReentry ? (
							<InlineNotice
								tone="danger"
								icon={IconAlertCircle}
								description={biometricError}
							/>
						) : null}

						{canUseBiometric ? (
							<>
								<BrandButton
									label={
										loading
											? m.mob_unlock_authenticating()
											: m.mob_unlock_biometric_label({
													biometricType: biometricTypeLabel,
												})
									}
									onPress={handleBiometricUnlock}
									isDisabled={loading}
									size="lg"
									leading={
										<BiometricGlyph
											token={biometricTypeToken}
											size={iconSize.header}
											className="text-accent-foreground"
										/>
									}
								/>
								<AuthDivider label={m.mob_unlock_or_divider()} />
							</>
						) : null}

						<PasswordField
							label={m.mob_unlock_password_label()}
							placeholder={m.mob_unlock_password_placeholder()}
							value={password}
							onChangeText={setPassword}
							icon={IconLock}
							autoFocus={requiresPasswordReentry}
							onSubmit={handlePasswordUnlock}
						/>

						{canUseBiometric ? (
							<Button
								onPress={handlePasswordUnlock}
								isDisabled={loading}
								variant="secondary"
								size="lg"
							>
								{loading
									? m.mob_unlock_button_unlocking()
									: m.mob_unlock_button_unlock()}
							</Button>
						) : (
							<BrandButton
								label={
									loading
										? m.mob_unlock_button_unlocking()
										: m.mob_unlock_button_unlock()
								}
								onPress={handlePasswordUnlock}
								isLoading={loading}
								size="lg"
							/>
						)}
					</View>
				</ScrollView>
			</KeyboardAvoidingView>
		</Screen>
	);
}
