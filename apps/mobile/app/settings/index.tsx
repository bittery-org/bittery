import { lockAllAccounts } from "@bittery/core/services/account-lifecycle";
import { useRouter } from "expo-router";
import {
	Button,
	Card,
	ControlField,
	Description,
	Label,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { Uniwind, useUniwind, withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { useBiometricType } from "@/lib/biometric-type";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import CredentialProvider from "../../modules/credential-provider";
import { useAccount } from "../../src/contexts/account-context";
import { lifecycleDeps } from "../../src/services/lifecycle";
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

export default function SettingsScreen() {
	const router = useRouter();
	const { m } = useI18n();
	const { activeAccount, allAccounts, refreshAccounts, removeAccount } =
		useAccount();
	const { theme } = useUniwind();

	const { label: biometricTypeLabel, token: biometricTypeToken } =
		useBiometricType();
	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricEnabled, setBiometricEnabled] = useState(false);
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

	const AUTO_LOCK_OPTIONS = useMemo(
		() => [
			{ label: m.mob_settings_auto_lock_1_min(), value: 60 * 1000 },
			{ label: m.mob_settings_auto_lock_5_min(), value: 5 * 60 * 1000 },
			{ label: m.mob_settings_auto_lock_10_min(), value: 10 * 60 * 1000 },
			{ label: m.mob_settings_auto_lock_30_min(), value: 30 * 60 * 1000 },
			{ label: m.mob_settings_auto_lock_1_hour(), value: 60 * 60 * 1000 },
			{ label: m.mob_settings_auto_lock_never(), value: -1 },
		],
		[m],
	);

	const loadSettings = useCallback(async () => {
		if (allAccounts.length === 0) return;

		const fallbackAccountId =
			activeAccount?.accountId || allAccounts[0]?.accountId;

		const details = await storage.getBiometricAvailabilityDetails();
		setBiometricDetails({
			hasHardware: details.hasHardware,
			isEnrolled: details.isEnrolled,
		});

		const available = details.hasHardware && details.isEnrolled;
		setBiometricAvailable(available);

		const enabled = await storage.isBiometricEnabled(fallbackAccountId);
		setBiometricEnabled(enabled);

		const timeout =
			await storage.getAutoLockTimeoutOrDefault(fallbackAccountId);
		setAutoLockTimeout(timeout);

		if (activeAccount) {
			const url = await storage.getServerUrl(activeAccount.accountId);
			setServerUrl(url);
		} else {
			setServerUrl(null);
		}

		// Calculate days until master password re-entry is required
		if (activeAccount) {
			const sessionData = await storage.getStoredSessionData(
				activeAccount.accountId,
			);
			if (sessionData) {
				// The stored period, not the compiled-in constant: `AccountStore` persists it
				// globally and applies that value, so reading it back is the only way this
				// countdown cannot disagree with the policy that actually fires.
				const periodMs = await storage.getMasterPasswordReentryPeriodMs();
				const lastEntry =
					sessionData.lastMasterPasswordEntry || sessionData.createdAt;
				const nextRequired = lastEntry + periodMs;
				const daysRemaining = Math.ceil(
					(nextRequired - Date.now()) / (24 * 60 * 60 * 1000),
				);
				setMasterPasswordDaysRemaining(Math.max(0, daysRemaining));
			}
		}
	}, [activeAccount, allAccounts]);

	useEffect(() => {
		loadSettings();
	}, [loadSettings]);

	/**
	 * Biometric unlock is presented here as a **device-wide** switch. `AccountStore.setBiometricEnabled`
	 * is per-account, so the fan-out over every account happens here at the call site, where the
	 * "this applies to every account on the device" intent is visible and reviewable.
	 */
	const handleBiometricToggle = async (value: boolean) => {
		if (allAccounts.length === 0) return;
		const fallbackAccountId =
			activeAccount?.accountId || allAccounts[0]?.accountId;

		try {
			if (value) {
				// Verify biometric before enabling. The prompt reason reaches the OS dialog,
				// so it has to be translated copy from up here.
				const success = await storage.authenticateWithBiometric(
					m.mob_settings_biometric_verify_prompt(),
					fallbackAccountId,
				);
				if (!success) {
					Alert.alert(
						m.mob_unlock_alert_error_title(),
						m.mob_settings_biometric_error(),
					);
					return;
				}
			}
			for (const account of await storage.getAccountsList()) {
				await storage.setBiometricEnabled(account.accountId, value);
			}
			setBiometricEnabled(value);
		} catch (error) {
			console.error("Error toggling biometric:", error);
			Alert.alert(
				m.mob_unlock_alert_error_title(),
				m.mob_settings_biometric_settings_error(),
			);
		}
	};

	const handleAutoLockChange = () => {
		Alert.alert(
			m.mob_settings_auto_lock_dialog_title(),
			m.mob_settings_auto_lock_dialog_description(),
			AUTO_LOCK_OPTIONS.map((option) => ({
				text: option.label,
				onPress: async () => {
					if (allAccounts.length === 0) return;
					// Device-wide, for the same reason as the biometric switch above:
					// `AccountStore` stores the timeout per account, so the fan-out is
					// spelled out here instead of being hidden below the seam.
					const accounts = await storage.getAccountsList();
					for (const account of accounts) {
						await storage.storeAutoLockTimeout(option.value, account.accountId);
					}
					setAutoLockTimeout(option.value);

					if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
						for (const account of accounts) {
							const sessionData = await storage.getStoredSessionData(
								account.accountId,
							);
							if (sessionData?.userId) {
								CredentialProvider.setMukAutoLockTimeout(
									option.value,
									sessionData.userId,
								);
							}
						}
					}
				},
			})),
		);
	};

	const getAutoLockLabel = (value: number) => {
		const option = AUTO_LOCK_OPTIONS.find((o) => o.value === value);
		return option?.label || m.mob_settings_auto_lock_10_min();
	};

	const handleThemeToggle = async (isDark: boolean) => {
		const newTheme = isDark ? "dark" : "light";
		Uniwind.setTheme(newTheme);
		await saveThemePreference(newTheme);
	};

	const accountLabel = activeAccount?.name || m.mob_settings_account_fallback();
	const accountValue = activeAccount?.email;
	const serverValue = serverUrl || m.mob_settings_server_not_set();
	const accountsForList = allAccounts.filter(
		(a) => a.accountId !== activeAccount?.accountId,
	);

	const handleLock = async () => {
		// Lock, don't sign out: `lockAllAccounts` drops every in-memory master unlock key —
		// including the native autofill mirror, purged first — but keeps `session_data`, so
		// quick-unlock still works.
		await lockAllAccounts(lifecycleDeps);

		router.replace("/(auth)/unlock");
	};

	const handleSignOut = async () => {
		const title = m.mob_settings_sign_out();
		const description = m.mob_settings_sign_out_description();

		Alert.alert(title, description, [
			{ text: m.mob_settings_cancel(), style: "cancel" },
			{
				text: m.mob_settings_sign_out(),
				style: "destructive",
				onPress: async () => {
					// Removal, not a session end: this drops the account from the device
					// entirely, which is what "sign out" has always meant on mobile.
					const outcome = activeAccount
						? await removeAccount(activeAccount.accountId)
						: null;
					await refreshAccounts();
					// A promoted successor is left locked, so it needs unlocking, not login.
					router.replace(
						outcome && outcome.remaining.length > 0
							? "/(auth)/unlock"
							: "/(auth)/login",
					);
				},
			},
		]);
	};

	const handleRemoveAccount = (accountId: string, email: string) => {
		Alert.alert(
			m.mob_settings_remove_account_title(),
			m.mob_settings_remove_account_message({ email }),
			[
				{ text: m.mob_settings_cancel(), style: "cancel" },
				{
					text: m.mob_settings_remove_account_confirm(),
					style: "destructive",
					onPress: async () => {
						// `outcome.remaining`, not the `allAccounts` snapshot this callback
						// closed over — that one still counts the account just removed.
						const outcome = await removeAccount(accountId);
						if (outcome.remaining.length === 0) {
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
			feedbackVariant="scale-highlight"
		>
			<View
				className={cn(
					"h-10",
					"w-10",
					"items-center",
					"justify-center",
					"rounded-lg",
					destructive ? "bg-danger-soft" : "bg-secondary",
				)}
			>
				<Icon
					size={20}
					className={destructive ? "text-danger" : "text-surface-foreground"}
				/>
			</View>
			<View className="flex-1">
				<Text
					className={cn(
						"font-medium",
						destructive ? "text-danger" : "text-foreground",
					)}
				>
					{label}
				</Text>
				{value && (
					<Text className="text-sm text-surface-foreground">{value}</Text>
				)}
			</View>
			{rightElement ||
				(onPress && (
					<StyledChevronRight size={20} className="text-surface-foreground" />
				))}
		</Button>
	);

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="px-4 py-4">
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
					<Card.Title className="flex-1 text-xl">
						{m.mob_settings_title()}
					</Card.Title>
				</View>
			</View>

			<ScrollView className="flex-1 px-2.5">
				{/* Account Section */}
				<Surface variant="secondary" className="mb-6 gap-0 p-0">
					<Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
						{m.mob_settings_section_account()}
					</Text>
					<SettingRow
						icon={StyledUser}
						label={accountLabel}
						value={accountValue}
					/>
					<SettingRow
						icon={StyledServer}
						label={m.mob_settings_server_label()}
						value={serverValue}
					/>
				</Surface>

				{/* Appearance Section */}
				<Surface variant="secondary" className="mb-6 gap-0 p-0">
					<Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
						{m.mob_settings_section_appearance()}
					</Text>

					<ControlField
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
							<Label>{m.mob_settings_dark_mode()}</Label>
							<Description>
								{theme === "dark"
									? m.mob_settings_enabled()
									: m.mob_settings_disabled()}
							</Description>
						</View>
						<ControlField.Indicator>
							<Switch />
						</ControlField.Indicator>
					</ControlField>
				</Surface>

				{/* Security Section */}
				<Surface variant="secondary" className="mb-6 gap-0 p-0">
					<Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
						{m.mob_settings_section_security()}
					</Text>
					<Text className="px-4 pb-2 text-muted text-xs">
						{m.mob_settings_security_hint()}
					</Text>
					{biometricAvailable && (
						<ControlField
							isSelected={biometricEnabled}
							onSelectedChange={handleBiometricToggle}
							className="px-4 py-4"
						>
							<View className="mr-4 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
								{biometricTypeToken === "face" ? (
									<StyledScanFace
										size={20}
										className="text-surface-foreground"
									/>
								) : (
									<StyledFingerprint
										size={20}
										className="text-surface-foreground"
									/>
								)}
							</View>
							<View className="flex-1">
								<Label>
									{m.mob_settings_biometric_unlock({
										biometricType: biometricTypeLabel,
									})}
								</Label>
								<Description>
									{biometricEnabled
										? m.mob_settings_enabled()
										: m.mob_settings_disabled()}
								</Description>
							</View>
							<ControlField.Indicator>
								<Switch />
							</ControlField.Indicator>
						</ControlField>
					)}

					{/* Show notice if device doesn't support biometrics */}
					{!biometricDetails.hasHardware && (
						<View className="px-4 py-4">
							<Card variant="secondary" className="gap-2 p-3">
								<View className="flex-row items-start gap-3">
									<StyledInfo size={18} className="text-surface-foreground" />
									<View className="flex-1">
										<Card.Title className="text-sm">
											{m.mob_settings_biometric_not_available_title()}
										</Card.Title>
										<Card.Description className="text-xs">
											{m.mob_settings_biometric_not_available_description()}
										</Card.Description>
									</View>
								</View>
							</Card>
						</View>
					)}

					{/* Show notice if hardware exists but no biometrics enrolled */}
					{biometricDetails.hasHardware && !biometricDetails.isEnrolled && (
						<View className="px-4 py-4">
							<Card variant="secondary" className="gap-2 bg-amber-50 p-3">
								<View className="flex-row items-start gap-3">
									<StyledAlertCircle size={18} className="text-amber-600" />
									<View className="flex-1">
										<Card.Title className="text-amber-800 text-sm">
											{m.mob_settings_biometric_setup_title()}
										</Card.Title>
										<Card.Description className="text-amber-700 text-xs">
											{m.mob_settings_biometric_setup_description()}
										</Card.Description>
									</View>
								</View>
							</Card>
						</View>
					)}

					<SettingRow
						icon={StyledClock}
						label={m.mob_settings_auto_lock_label()}
						value={getAutoLockLabel(autoLockTimeout)}
						onPress={handleAutoLockChange}
					/>

					{/* Master password re-entry info */}
					{biometricEnabled && masterPasswordDaysRemaining !== null && (
						<View className="px-4 py-4">
							<Card className="gap-2 bg-accent-soft p-3 text-accent-soft-foreground">
								<View className="flex-row items-center gap-3">
									<StyledLock
										size={18}
										className="text-accent-soft-foreground"
									/>
									<View className="flex-1">
										<Card.Title className="text-accent-soft-foreground text-sm">
											{m.mob_settings_password_check_title()}
										</Card.Title>
										<Card.Description className="text-accent-soft-foreground text-xs">
											{masterPasswordDaysRemaining > 0
												? m.mob_settings_password_check_days_remaining({
														days: String(masterPasswordDaysRemaining),
													})
												: m.mob_settings_password_check_now()}
										</Card.Description>
									</View>
								</View>
							</Card>
						</View>
					)}

					<SettingRow
						icon={StyledLock}
						label={m.mob_settings_lock_vault()}
						onPress={handleLock}
					/>
				</Surface>

				{/* Accessibility Section */}
				<Surface variant="secondary" className="mb-6 gap-0 p-0">
					<Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
						{m.mob_settings_section_accessibility()}
					</Text>

					<View className="px-4 py-4">
						<View className="gap-2 p-3">
							<View className="flex-row items-start gap-3">
								<StyledInfo size={18} className="text-surface-foreground" />
								<View className="flex-1">
									<Card.Title className="text-sm">
										{m.mob_settings_accessibility_title()}
									</Card.Title>
									<Card.Description className="text-xs">
										{m.mob_settings_accessibility_description()}
									</Card.Description>
								</View>
							</View>
						</View>
					</View>
				</Surface>

				{/* Multiple Accounts */}
				{accountsForList.length > 0 && (
					<Surface variant="secondary" className="mb-6 gap-0 p-0">
						<Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
							{m.mob_settings_section_other_accounts()}
						</Text>
						{accountsForList.map((account) => (
							<View key={account.email}>
								<SettingRow
									icon={StyledUser}
									label={account.name || account.email.split("@")[0]}
									value={account.email}
									onPress={() =>
										handleRemoveAccount(account.accountId, account.email)
									}
									rightElement={
										<Button
											isIconOnly
											variant="ghost"
											size="sm"
											onPress={() =>
												handleRemoveAccount(account.accountId, account.email)
											}
										>
											<StyledTrash2 size={18} className="text-danger" />
										</Button>
									}
								/>
							</View>
						))}
					</Surface>
				)}

				{/* Danger Zone */}
				<Surface variant="secondary" className="mb-6 gap-0 p-0">
					<Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
						{m.mob_settings_section_danger()}
					</Text>
					<SettingRow
						icon={StyledLogOut}
						label={m.mob_settings_sign_out()}
						value={m.mob_settings_sign_out_value()}
						onPress={handleSignOut}
						destructive
					/>
				</Surface>

				{/* App Info */}
				<View className="items-center gap-1 py-8">
					<Text className="text-sm text-surface-foreground">
						{m.mob_settings_app_name()}
					</Text>
					<Text className="text-surface-foreground text-xs">
						{m.mob_settings_app_version()}
					</Text>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}
