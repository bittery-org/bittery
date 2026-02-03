import { MASTER_PASSWORD_REENTRY_PERIOD_MS } from "@bittery/storage";
import { useRouter } from "expo-router";
import {
	Button,
	Card,
	Divider,
	FormField,
	Surface,
	Switch,
} from "heroui-native";
import {
	AlertCircle,
	ArrowLeft,
	ChevronRight,
	Clock,
	Fingerprint,
	Info,
	Lock,
	LogOut,
	Moon,
	ScanFace,
	Server,
	Sun,
	Trash2,
	User,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { Uniwind, useUniwind, withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import CredentialProvider from "../../modules/credential-provider";
import { useAccount } from "../../src/contexts/account-context";
import { storage } from "../../src/services/storage";
import { saveThemePreference } from "../../src/services/theme-storage";

// Create styled icon components
const StyledUser = withUniwind(User);
const StyledServer = withUniwind(Server);
const StyledFingerprint = withUniwind(Fingerprint);
const StyledScanFace = withUniwind(ScanFace);
const StyledClock = withUniwind(Clock);
const StyledLock = withUniwind(Lock);
const StyledLogOut = withUniwind(LogOut);
const StyledTrash2 = withUniwind(Trash2);
const StyledChevronRight = withUniwind(ChevronRight);
const StyledArrowLeft = withUniwind(ArrowLeft);
const StyledInfo = withUniwind(Info);
const StyledAlertCircle = withUniwind(AlertCircle);
const StyledMoon = withUniwind(Moon);
const StyledSun = withUniwind(Sun);

const AUTO_LOCK_OPTIONS = [
	{ label: "1 minute", value: 60 * 1000 },
	{ label: "5 minutes", value: 5 * 60 * 1000 },
	{ label: "10 minutes", value: 10 * 60 * 1000 },
	{ label: "30 minutes", value: 30 * 60 * 1000 },
	{ label: "1 hour", value: 60 * 60 * 1000 },
	{ label: "Never", value: -1 },
];

export default function SettingsScreen() {
	const router = useRouter();
	const { activeAccount, allAccounts, refreshAccounts, removeAccount } =
		useAccount();
	const { theme } = useUniwind();

	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricEnabled, setBiometricEnabled] = useState(false);
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [biometricDetails, setBiometricDetails] = useState<{
		hasHardware: boolean;
		isEnrolled: boolean;
	}>({ hasHardware: false, isEnrolled: false });
	const [autoLockTimeout, setAutoLockTimeout] = useState<number>(
		10 * 60 * 1000,
	);
	const [serverUrl, setServerUrl] = useState<string | null>(null);
	const [masterPasswordDaysRemaining, setMasterPasswordDaysRemaining] =
		useState<number | null>(null);

	const loadSettings = useCallback(async () => {
		if (!activeAccount) return;

		const details = await storage.getBiometricAvailabilityDetails();
		setBiometricDetails({
			hasHardware: details.hasHardware,
			isEnrolled: details.isEnrolled,
		});

		const available = details.hasHardware && details.isEnrolled;
		setBiometricAvailable(available);

		if (available) {
			const type = await storage.getBiometricType();
			setBiometricType(type);
		}

		const enabled = await storage.isBiometricEnabled(activeAccount.email);
		setBiometricEnabled(enabled);

		const timeout = await storage.getAutoLockTimeoutOrDefault(
			activeAccount.email,
		);
		setAutoLockTimeout(timeout);

		const url = await storage.getServerUrl(activeAccount.email);
		setServerUrl(url);

		// Calculate days until master password re-entry is required
		const sessionData = await storage.getStoredSessionData(activeAccount.email);
		if (sessionData) {
			const lastEntry =
				sessionData.lastMasterPasswordEntry || sessionData.createdAt;
			const nextRequired = lastEntry + MASTER_PASSWORD_REENTRY_PERIOD_MS;
			const daysRemaining = Math.ceil(
				(nextRequired - Date.now()) / (24 * 60 * 60 * 1000),
			);
			setMasterPasswordDaysRemaining(Math.max(0, daysRemaining));
		}
	}, [activeAccount]);

	useEffect(() => {
		loadSettings();
	}, [loadSettings]);

	const handleBiometricToggle = async (value: boolean) => {
		if (!activeAccount) return;

		try {
			if (value) {
				// Verify biometric before enabling
				const success = await storage.authenticateWithBiometric(
					"Verify your identity to enable biometric unlock",
					activeAccount.email,
				);
				if (!success) {
					Alert.alert("Error", "Biometric authentication failed");
					return;
				}
				await storage.enableBiometric(activeAccount.email);
			} else {
				await storage.disableBiometric(activeAccount.email);
			}
			setBiometricEnabled(value);
		} catch (error) {
			console.error("Error toggling biometric:", error);
			Alert.alert("Error", "Failed to update biometric settings");
		}
	};

	const handleAutoLockChange = () => {
		Alert.alert(
			"Auto-Lock Timeout",
			"Select when to automatically lock the vault",
			AUTO_LOCK_OPTIONS.map((option) => ({
				text: option.label,
				onPress: async () => {
					if (!activeAccount) return;
					await storage.storeAutoLockTimeout(option.value, activeAccount.email);
					setAutoLockTimeout(option.value);
				},
			})),
		);
	};

	const getAutoLockLabel = (value: number) => {
		const option = AUTO_LOCK_OPTIONS.find((o) => o.value === value);
		return option?.label || "10 minutes";
	};

	const handleThemeToggle = async (isDark: boolean) => {
		const newTheme = isDark ? "dark" : "light";
		Uniwind.setTheme(newTheme);
		await saveThemePreference(newTheme);
	};

	const handleLock = async () => {
		// Clear React Native session (in-memory cache)
		await storage.clearSession();

		// IMPORTANT: Clear MUK from native VaultStateManager for autofill security
		// Without this, autofill will still work even when app is locked!
		if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
			const wasUnlocked = CredentialProvider.isVaultUnlocked();
			CredentialProvider.clearMasterUnlockKey();
			const isNowUnlocked = CredentialProvider.isVaultUnlocked();
			console.log(
				`[Lock] Vault was unlocked: ${wasUnlocked}, now unlocked: ${isNowUnlocked}`,
			);
		}

		router.replace("/(auth)/unlock");
	};

	const handleSignOut = async () => {
		Alert.alert(
			"Sign Out",
			"This will remove your account from this device. You'll need your Secret Key to sign in again.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Sign Out",
					style: "destructive",
					onPress: async () => {
						if (activeAccount) {
							await removeAccount(activeAccount.email);
						}
						await refreshAccounts();
						router.replace("/(auth)/login");
					},
				},
			],
		);
	};

	const handleRemoveAccount = (email: string) => {
		Alert.alert(
			"Remove Account",
			`Are you sure you want to remove ${email} from this device?`,
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Remove",
					style: "destructive",
					onPress: async () => {
						await removeAccount(email);
						if (allAccounts.length <= 1) {
							router.replace("/(auth)/login");
						}
					},
				},
			],
		);
	};

	// Reusable setting row component
	const SettingRow = ({
		icon: Icon,
		label,
		value,
		onPress,
		rightElement,
		destructive,
	}: {
		icon: React.ComponentType<{ size: number; className?: string }>;
		label: string;
		value?: string;
		onPress?: () => void;
		rightElement?: React.ReactNode;
		destructive?: boolean;
	}) => (
		<Button
			onPress={onPress}
			isDisabled={!onPress && !rightElement}
			variant="ghost"
			className="h-auto min-h-0 w-full justify-start gap-4 rounded-none px-4 py-4"
			pressableFeedbackVariant="highlight"
		>
			<View
				className={`h-10 w-10 items-center justify-center rounded-lg ${
					destructive ? "bg-danger-soft" : "bg-secondary"
				}`}
			>
				<Icon
					size={20}
					className={destructive ? "text-danger" : "text-surface-foreground"}
				/>
			</View>
			<View className="flex-1">
				<Text
					className={`font-medium ${
						destructive ? "text-danger" : "text-foreground"
					}`}
				>
					{label}
				</Text>
				{value && (
					<Text className="text-surface-foreground text-sm">{value}</Text>
				)}
			</View>
			{rightElement ||
				(onPress && <StyledChevronRight size={20} className="text-surface-foreground" />)}
		</Button>
	);

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="border-border border-b px-4 py-4">
				<View className="flex-row items-center">
					<Button
						isIconOnly
						variant="secondary"
						size="sm"
						onPress={() => router.back()}
						className="mr-3"
					>
						<StyledArrowLeft size={18} className="text-foreground" />
					</Button>
					<Card.Title className="flex-1 text-xl">Settings</Card.Title>
				</View>
			</View>

			<ScrollView className="flex-1">
				{/* Account Section */}
				<Surface variant="transparent" className="mb-6 gap-0 p-0">
					<Text className="px-4 py-3 font-semibold text-surface-foreground text-sm uppercase">
						Account
					</Text>
					<Surface variant="secondary" className="gap-0 p-0">
						<SettingRow
							icon={StyledUser}
							label={activeAccount?.name || "Account"}
							value={activeAccount?.email}
						/>
						<Divider />
						<SettingRow
							icon={StyledServer}
							label="Server"
							value={serverUrl || "Not set"}
						/>
					</Surface>
				</Surface>

				{/* Appearance Section */}
				<Surface variant="transparent" className="mb-6 gap-0 p-0">
					<Text className="px-4 py-3 font-semibold text-surface-foreground text-sm uppercase">
						Appearance
					</Text>
					<Surface variant="secondary" className="gap-0 p-0">
						<FormField
							isSelected={theme === "dark"}
							onSelectedChange={handleThemeToggle}
							className="px-4 py-4"
						>
							<View className="mr-4 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
								{theme === "dark" ? (
									<StyledMoon size={20} className="text-surface-foreground" />
								) : (
									<StyledSun size={20} className="text-surface-foreground" />
								)}
							</View>
							<View className="flex-1">
								<FormField.Label>Dark Mode</FormField.Label>
								<FormField.Description>
									{theme === "dark" ? "Enabled" : "Disabled"}
								</FormField.Description>
							</View>
							<FormField.Indicator>
								<Switch />
							</FormField.Indicator>
						</FormField>
					</Surface>
				</Surface>

				{/* Security Section */}
				<Surface variant="transparent" className="mb-6 gap-0 p-0">
					<Text className="px-4 py-3 font-semibold text-surface-foreground text-sm uppercase">
						Security
					</Text>
					<Surface variant="secondary" className="gap-0 p-0">
						{biometricAvailable && (
							<>
								<FormField
									isSelected={biometricEnabled}
									onSelectedChange={handleBiometricToggle}
									className="px-4 py-4"
								>
									<View className="mr-4 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
										{biometricType === "Face ID" ? (
											<StyledScanFace size={20} className="text-surface-foreground" />
										) : (
											<StyledFingerprint size={20} className="text-surface-foreground" />
										)}
									</View>
									<View className="flex-1">
										<FormField.Label>
											{biometricType || "Biometric"} Unlock
										</FormField.Label>
										<FormField.Description>
											{biometricEnabled ? "Enabled" : "Disabled"}
										</FormField.Description>
									</View>
									<FormField.Indicator>
										<Switch />
									</FormField.Indicator>
								</FormField>
								<Divider />
							</>
						)}

						{/* Show notice if device doesn't support biometrics */}
						{!biometricDetails.hasHardware && (
							<>
								<View className="px-4 py-4">
									<Card variant="secondary" className="gap-2 p-3">
										<View className="flex-row items-start gap-3">
											<StyledInfo size={18} className="text-surface-foreground" />
											<View className="flex-1">
												<Card.Title className="text-sm">
													Biometric Not Available
												</Card.Title>
												<Card.Description className="text-xs">
													This device does not support biometric authentication.
													Your vault is secured with your master password.
												</Card.Description>
											</View>
										</View>
									</Card>
								</View>
								<Divider />
							</>
						)}

						{/* Show notice if hardware exists but no biometrics enrolled */}
						{biometricDetails.hasHardware && !biometricDetails.isEnrolled && (
							<>
								<View className="px-4 py-4">
									<Card variant="secondary" className="gap-2 bg-amber-50 p-3">
										<View className="flex-row items-start gap-3">
											<StyledAlertCircle size={18} className="text-amber-600" />
											<View className="flex-1">
												<Card.Title className="text-amber-800 text-sm">
													Set Up Biometric
												</Card.Title>
												<Card.Description className="text-amber-700 text-xs">
													Enable Face ID or Touch ID in your device settings to
													use biometric unlock.
												</Card.Description>
											</View>
										</View>
									</Card>
								</View>
								<Divider />
							</>
						)}

						<SettingRow
							icon={StyledClock}
							label="Auto-Lock"
							value={getAutoLockLabel(autoLockTimeout)}
							onPress={handleAutoLockChange}
						/>
						<Divider />

						{/* Master password re-entry info */}
						{biometricEnabled && masterPasswordDaysRemaining !== null && (
							<>
								<View className="px-4 py-4">
									<Card variant="quaternary" className="gap-2 p-3">
										<View className="flex-row items-center gap-3">
											<StyledLock size={18} className="text-surface-foreground" />
											<View className="flex-1">
												<Card.Title className="text-surface-foreground text-sm">
													Password Check
												</Card.Title>
												<Card.Description className="text-muted text-xs">
													{masterPasswordDaysRemaining > 0
														? `Master password required in ${masterPasswordDaysRemaining} days for security verification.`
														: "Master password required on next unlock for security verification."}
												</Card.Description>
											</View>
										</View>
									</Card>
								</View>
								<Divider />
							</>
						)}

						<SettingRow
							icon={StyledLock}
							label="Lock Vault"
							onPress={handleLock}
						/>
					</Surface>
				</Surface>

				{/* Accessibility Section */}
				<Surface variant="transparent" className="mb-6 gap-0 p-0">
					<Text className="px-4 py-3 font-semibold text-surface-foreground text-sm uppercase">
						Accessibility
					</Text>
					<Surface variant="secondary" className="gap-0 p-0">
						<View className="px-4 py-4">
							<Card variant="secondary" className="gap-2 p-3">
								<View className="flex-row items-start gap-3">
									<StyledInfo size={18} className="text-surface-foreground" />
									<View className="flex-1">
										<Card.Title className="text-sm">
											Alternative Access
										</Card.Title>
										<Card.Description className="text-xs">
											If you cannot use biometric authentication, you can always
											unlock your vault using your master password. The password
											option is available on the unlock screen.
										</Card.Description>
									</View>
								</View>
							</Card>
						</View>
					</Surface>
				</Surface>

				{/* Multiple Accounts */}
				{allAccounts.length > 1 && (
					<Surface variant="transparent" className="mb-6 gap-0 p-0">
						<Text className="px-4 py-3 font-semibold text-surface-foreground text-sm uppercase">
							Other Accounts
						</Text>
						<Surface variant="secondary" className="gap-0 p-0">
							{allAccounts
								.filter((a) => a.email !== activeAccount?.email)
								.map((account, index) => (
									<View key={account.email}>
										{index > 0 && <Divider />}
										<SettingRow
											icon={StyledUser}
											label={account.name || account.email.split("@")[0]}
											value={account.email}
											onPress={() => handleRemoveAccount(account.email)}
											rightElement={
												<Button
													isIconOnly
													variant="ghost"
													size="sm"
													onPress={() => handleRemoveAccount(account.email)}
												>
													<StyledTrash2 size={18} className="text-danger" />
												</Button>
											}
										/>
									</View>
								))}
						</Surface>
					</Surface>
				)}

				{/* Danger Zone */}
				<Surface variant="transparent" className="mb-6 gap-0 p-0">
					<Text className="px-4 py-3 font-semibold text-surface-foreground text-sm uppercase">
						Danger Zone
					</Text>
					<Surface variant="secondary" className="gap-0 p-0">
						<SettingRow
							icon={StyledLogOut}
							label="Sign Out"
							value="Remove this account from device"
							onPress={handleSignOut}
							destructive
						/>
					</Surface>
				</Surface>

				{/* App Info */}
				<View className="items-center gap-1 py-8">
					<Text className="text-surface-foreground text-sm">Bittery Mobile</Text>
					<Text className="text-surface-foreground text-xs">Version 0.1.0</Text>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}
