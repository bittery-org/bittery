import { lockAllAccounts } from "@bittery/core/services/account-lifecycle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ControlField, Switch } from "heroui-native";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { Uniwind, useUniwind } from "uniwind";
import {
	AppBar,
	type AppIcon,
	GradientTile,
	IconClock,
	IconFingerprint,
	IconInfo,
	IconLock,
	IconLogOut,
	IconMoon,
	IconScanFace,
	IconServer,
	IconSun,
	IconTrash,
	IconTriangleAlert,
	IconUser,
	iconSize,
	ListCard,
	ListRow,
	layout,
	Screen,
	SectionLabel,
	useBottomInset,
} from "@/components/ui";
import { useBiometricType } from "@/lib/biometric-type";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import CredentialProvider from "../../modules/credential-provider";
import { useAccount } from "../contexts/account-context";
import { lifecycleDeps } from "../services/lifecycle";
import { storage } from "../services/storage";
import { saveThemePreference } from "../services/theme-storage";

const DEFAULT_AUTO_LOCK_MS = 10 * 60 * 1000;

interface DeviceSettings {
	hasBiometricHardware: boolean;
	isBiometricEnrolled: boolean;
	isBiometricEnabled: boolean;
	autoLockTimeout: number;
	serverUrl: string | null;
	masterPasswordDaysRemaining: number | null;
}

const SETTINGS_FALLBACK: DeviceSettings = {
	hasBiometricHardware: false,
	isBiometricEnrolled: false,
	isBiometricEnabled: false,
	autoLockTimeout: DEFAULT_AUTO_LOCK_MS,
	serverUrl: null,
	masterPasswordDaysRemaining: null,
};

/** Neutral leading tile for a settings row; danger rows swap to the soft red well. */
function SettingTile({
	icon: Icon,
	tone = "default",
}: {
	icon: AppIcon;
	tone?: "default" | "danger";
}) {
	return (
		<View
			className={cn(
				"h-10 w-10 items-center justify-center rounded-xl",
				tone === "danger" ? "bg-danger-soft" : "bg-field",
			)}
		>
			<Icon
				size={iconSize.row}
				className={tone === "danger" ? "text-danger" : "text-muted"}
			/>
		</View>
	);
}

/** Inline advisory block — status colour on its soft background, never a fill. */
function Notice({
	icon: Icon,
	title,
	description,
	tone,
}: {
	icon: AppIcon;
	title: string;
	description: string;
	tone: "info" | "warning" | "accent";
}) {
	const surface = {
		info: "bg-surface-tertiary",
		warning: "bg-warning-soft",
		accent: "bg-accent-soft",
	}[tone];
	const foreground = {
		info: "text-muted",
		warning: "text-warning",
		accent: "text-accent",
	}[tone];

	return (
		<View className={cn("mt-2 flex-row gap-3 rounded-2xl p-3.5", surface)}>
			<Icon size={iconSize.row} className={cn("mt-0.5", foreground)} />
			<View className="min-w-0 flex-1">
				<Text className="font-medium text-base text-foreground">{title}</Text>
				<Text className="mt-0.5 text-muted text-sm">{description}</Text>
			</View>
		</View>
	);
}

/**
 * The settings surface, rendered both as the Settings tab and as the stack
 * route the account sheet deep-links to.
 */
export function SettingsScreen({
	presentation = "tab",
}: {
	presentation?: "tab" | "stack";
}) {
	const router = useRouter();
	const { m } = useI18n();
	const { activeAccount, allAccounts, refreshAccounts, removeAccount } =
		useAccount();
	const { theme } = useUniwind();
	const queryClient = useQueryClient();
	const bottomInset = useBottomInset({ tabBar: presentation === "tab" });

	const { label: biometricTypeLabel, token: biometricTypeToken } =
		useBiometricType();

	const autoLockOptions = [
		{ label: m.mob_settings_auto_lock_1_min(), value: 60 * 1000 },
		{ label: m.mob_settings_auto_lock_5_min(), value: 5 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_10_min(), value: DEFAULT_AUTO_LOCK_MS },
		{ label: m.mob_settings_auto_lock_30_min(), value: 30 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_1_hour(), value: 60 * 60 * 1000 },
		{ label: m.mob_settings_auto_lock_never(), value: -1 },
	];

	const settingsKey = [
		"mobile-device-settings",
		activeAccount?.accountId ?? null,
		allAccounts.length,
	];

	const settingsQuery = useQuery<DeviceSettings>({
		queryKey: settingsKey,
		enabled: allAccounts.length > 0,
		queryFn: async () => {
			const fallbackAccountId =
				activeAccount?.accountId || allAccounts[0]?.accountId;

			const details = await storage.getBiometricAvailabilityDetails();
			const isBiometricEnabled =
				await storage.isBiometricEnabled(fallbackAccountId);
			const autoLockTimeout =
				await storage.getAutoLockTimeoutOrDefault(fallbackAccountId);

			let serverUrl: string | null = null;
			let masterPasswordDaysRemaining: number | null = null;

			if (activeAccount) {
				serverUrl = await storage.getServerUrl(activeAccount.accountId);

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
					masterPasswordDaysRemaining = Math.max(
						0,
						Math.ceil(
							(lastEntry + periodMs - Date.now()) / (24 * 60 * 60 * 1000),
						),
					);
				}
			}

			return {
				hasBiometricHardware: details.hasHardware,
				isBiometricEnrolled: details.isEnrolled,
				isBiometricEnabled,
				autoLockTimeout,
				serverUrl,
				masterPasswordDaysRemaining,
			};
		},
	});

	const settings = settingsQuery.data ?? SETTINGS_FALLBACK;
	const isBiometricAvailable =
		settings.hasBiometricHardware && settings.isBiometricEnrolled;

	const patchSettings = (patch: Partial<DeviceSettings>) => {
		queryClient.setQueryData<DeviceSettings>(settingsKey, (current) => ({
			...(current ?? SETTINGS_FALLBACK),
			...patch,
		}));
	};

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
						m.mob_common_error_title(),
						m.mob_settings_biometric_error(),
					);
					return;
				}
			}
			for (const account of await storage.getAccountsList()) {
				await storage.setBiometricEnabled(account.accountId, value);
			}
			patchSettings({ isBiometricEnabled: value });
		} catch (error) {
			console.error("Error toggling biometric:", error);
			Alert.alert(
				m.mob_common_error_title(),
				m.mob_settings_biometric_settings_error(),
			);
		}
	};

	const handleAutoLockChange = () => {
		Alert.alert(
			m.mob_settings_auto_lock_dialog_title(),
			m.mob_settings_auto_lock_dialog_description(),
			autoLockOptions.map((option) => ({
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
					patchSettings({ autoLockTimeout: option.value });

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

	const handleThemeToggle = async (isDark: boolean) => {
		const nextTheme = isDark ? "dark" : "light";
		Uniwind.setTheme(nextTheme);
		await saveThemePreference(nextTheme);
	};

	const handleLock = async () => {
		// Lock, don't sign out: `lockAllAccounts` drops every in-memory master unlock key —
		// including the native autofill mirror, purged first — but keeps `session_data`, so
		// quick-unlock still works.
		await lockAllAccounts(lifecycleDeps);

		router.replace("/(auth)/unlock");
	};

	const handleSignOut = () => {
		Alert.alert(
			m.mob_settings_sign_out(),
			m.mob_settings_sign_out_description(),
			[
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
			],
		);
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

	const accountLabel = activeAccount?.name || m.mob_settings_account_fallback();
	const autoLockLabel =
		autoLockOptions.find((option) => option.value === settings.autoLockTimeout)
			?.label ?? m.mob_settings_auto_lock_10_min();
	const otherAccounts = allAccounts.filter(
		(account) => account.accountId !== activeAccount?.accountId,
	);

	return (
		<Screen>
			<AppBar
				showBack={presentation === "stack"}
				largeTitle={m.mob_settings_title()}
			/>
			<ScrollView
				className="flex-1"
				contentContainerStyle={{
					paddingHorizontal: layout.screenPadding,
					paddingBottom: bottomInset,
					gap: layout.gap.lg,
				}}
			>
				<View>
					<SectionLabel>{m.mob_settings_section_account()}</SectionLabel>
					<ListCard>
						<ListRow
							title={accountLabel}
							subtitle={activeAccount?.email}
							leading={
								<GradientTile name={accountLabel} accent>
									<IconUser size={iconSize.row} className="text-white" />
								</GradientTile>
							}
						/>
						<ListRow
							title={m.mob_settings_server_label()}
							subtitle={settings.serverUrl ?? m.mob_settings_server_not_set()}
							leading={<SettingTile icon={IconServer} />}
						/>
					</ListCard>
				</View>

				<View>
					<SectionLabel>{m.mob_settings_section_appearance()}</SectionLabel>
					<ListCard>
						<ControlField
							isSelected={theme === "dark"}
							onSelectedChange={handleThemeToggle}
							className="min-h-14 gap-3 px-4 py-3"
						>
							<SettingTile icon={theme === "dark" ? IconMoon : IconSun} />
							<View className="min-w-0 flex-1">
								<Text className="font-medium text-base text-foreground">
									{m.mob_settings_dark_mode()}
								</Text>
								<Text className="mt-0.5 text-muted text-sm">
									{theme === "dark"
										? m.mob_settings_enabled()
										: m.mob_settings_disabled()}
								</Text>
							</View>
							<ControlField.Indicator>
								<Switch />
							</ControlField.Indicator>
						</ControlField>
					</ListCard>
				</View>

				<View>
					<SectionLabel>{m.mob_settings_section_security()}</SectionLabel>
					<ListCard>
						{isBiometricAvailable ? (
							<ControlField
								isSelected={settings.isBiometricEnabled}
								onSelectedChange={handleBiometricToggle}
								className="min-h-14 gap-3 px-4 py-3"
							>
								<SettingTile
									icon={
										biometricTypeToken === "face"
											? IconScanFace
											: IconFingerprint
									}
								/>
								<View className="min-w-0 flex-1">
									<Text className="font-medium text-base text-foreground">
										{m.mob_settings_biometric_unlock({
											biometricType: biometricTypeLabel,
										})}
									</Text>
									<Text className="mt-0.5 text-muted text-sm">
										{settings.isBiometricEnabled
											? m.mob_settings_enabled()
											: m.mob_settings_disabled()}
									</Text>
								</View>
								<ControlField.Indicator>
									<Switch />
								</ControlField.Indicator>
							</ControlField>
						) : null}
						<ListRow
							title={m.mob_settings_auto_lock_label()}
							subtitle={autoLockLabel}
							leading={<SettingTile icon={IconClock} />}
							onPress={handleAutoLockChange}
							showChevron
						/>
						<ListRow
							title={m.mob_settings_lock_vault()}
							leading={<SettingTile icon={IconLock} />}
							onPress={handleLock}
							compact
							showChevron
						/>
					</ListCard>
					<Text className="px-1 pt-2 text-muted text-xs">
						{m.mob_settings_security_hint()}
					</Text>

					{settings.hasBiometricHardware ? null : (
						<Notice
							tone="info"
							icon={IconInfo}
							title={m.mob_settings_biometric_not_available_title()}
							description={m.mob_settings_biometric_not_available_description()}
						/>
					)}
					{settings.hasBiometricHardware && !settings.isBiometricEnrolled ? (
						<Notice
							tone="warning"
							icon={IconTriangleAlert}
							title={m.mob_settings_biometric_setup_title()}
							description={m.mob_settings_biometric_setup_description()}
						/>
					) : null}
					{settings.isBiometricEnabled &&
					settings.masterPasswordDaysRemaining !== null ? (
						<Notice
							tone="accent"
							icon={IconLock}
							title={m.mob_settings_password_check_title()}
							description={
								settings.masterPasswordDaysRemaining > 0
									? m.mob_settings_password_check_days_remaining({
											days: String(settings.masterPasswordDaysRemaining),
										})
									: m.mob_settings_password_check_now()
							}
						/>
					) : null}
				</View>

				<View>
					<SectionLabel>{m.mob_settings_section_data()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.mob_tab_trash()}
							subtitle={m.mob_settings_trash_value()}
							leading={<SettingTile icon={IconTrash} />}
							onPress={() => router.push("/(tabs)/trash")}
							showChevron
						/>
					</ListCard>
				</View>

				{otherAccounts.length > 0 ? (
					<View>
						<SectionLabel>
							{m.mob_settings_section_other_accounts()}
						</SectionLabel>
						<ListCard>
							{otherAccounts.map((account) => (
								<ListRow
									key={account.accountId}
									title={account.name || account.email}
									subtitle={account.email}
									leading={
										<GradientTile name={account.name || account.email}>
											<IconUser size={iconSize.row} className="text-white" />
										</GradientTile>
									}
									onPress={() =>
										handleRemoveAccount(account.accountId, account.email)
									}
									trailing={
										<IconTrash size={iconSize.row} className="text-danger" />
									}
								/>
							))}
						</ListCard>
					</View>
				) : null}

				<View>
					<SectionLabel>{m.mob_settings_section_about()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.mob_settings_app_name()}
							value={m.mob_settings_app_version()}
							leading={<SettingTile icon={IconInfo} />}
							compact
						/>
					</ListCard>
					<Notice
						tone="info"
						icon={IconInfo}
						title={m.mob_settings_accessibility_title()}
						description={m.mob_settings_accessibility_description()}
					/>
				</View>

				<View>
					<SectionLabel>{m.mob_settings_section_danger()}</SectionLabel>
					<ListCard>
						<ListRow
							title={m.mob_settings_sign_out()}
							subtitle={m.mob_settings_sign_out_value()}
							tone="danger"
							leading={<SettingTile icon={IconLogOut} tone="danger" />}
							onPress={handleSignOut}
						/>
					</ListCard>
				</View>
			</ScrollView>
		</Screen>
	);
}
