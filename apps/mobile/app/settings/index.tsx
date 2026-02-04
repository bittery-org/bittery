import { MASTER_PASSWORD_REENTRY_PERIOD_MS } from "@bittery/storage";
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
  const {
    activeAccount,
    isAllAccountsMode,
    allAccounts,
    refreshAccounts,
    removeAccount,
  } = useAccount();
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
    if (allAccounts.length === 0) return;

    const fallbackEmail = activeAccount?.email || allAccounts[0]?.email;

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

    const enabled = await storage.isBiometricEnabled(fallbackEmail);
    setBiometricEnabled(enabled);

    const timeout = await storage.getAutoLockTimeoutOrDefault(fallbackEmail);
    setAutoLockTimeout(timeout);

    if (!isAllAccountsMode && activeAccount) {
      const url = await storage.getServerUrl(activeAccount.email);
      setServerUrl(url);
    } else {
      setServerUrl(null);
    }

    // Calculate days until master password re-entry is required
    if (isAllAccountsMode) {
      const daysRemainingList = await Promise.all(
        allAccounts.map(async (account) => {
          const sessionData = await storage.getStoredSessionData(account.email);
          if (!sessionData) return null;
          const lastEntry =
            sessionData.lastMasterPasswordEntry || sessionData.createdAt;
          const nextRequired = lastEntry + MASTER_PASSWORD_REENTRY_PERIOD_MS;
          const daysRemaining = Math.ceil(
            (nextRequired - Date.now()) / (24 * 60 * 60 * 1000),
          );
          return Math.max(0, daysRemaining);
        }),
      );
      const filtered = daysRemainingList.filter(
        (value): value is number => value !== null,
      );
      setMasterPasswordDaysRemaining(
        filtered.length > 0 ? Math.min(...filtered) : null,
      );
    } else if (activeAccount) {
      const sessionData = await storage.getStoredSessionData(
        activeAccount.email,
      );
      if (sessionData) {
        const lastEntry =
          sessionData.lastMasterPasswordEntry || sessionData.createdAt;
        const nextRequired = lastEntry + MASTER_PASSWORD_REENTRY_PERIOD_MS;
        const daysRemaining = Math.ceil(
          (nextRequired - Date.now()) / (24 * 60 * 60 * 1000),
        );
        setMasterPasswordDaysRemaining(Math.max(0, daysRemaining));
      }
    }
  }, [activeAccount, allAccounts, isAllAccountsMode]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleBiometricToggle = async (value: boolean) => {
    if (allAccounts.length === 0) return;
    const fallbackEmail = activeAccount?.email || allAccounts[0]?.email;

    try {
      if (value) {
        // Verify biometric before enabling
        const success = await storage.authenticateWithBiometric(
          "Verify your identity to enable biometric unlock",
          fallbackEmail,
        );
        if (!success) {
          Alert.alert("Error", "Biometric authentication failed");
          return;
        }
        await storage.enableBiometric(fallbackEmail);
      } else {
        await storage.disableBiometric(fallbackEmail);
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
          if (allAccounts.length === 0) return;
          await storage.storeAutoLockTimeout(option.value);
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

  const accountLabel = isAllAccountsMode
    ? "All Accounts"
    : activeAccount?.name || "Account";
  const accountValue = isAllAccountsMode
    ? `${allAccounts.length} accounts`
    : activeAccount?.email;
  const serverValue = isAllAccountsMode
    ? "Per account"
    : serverUrl || "Not set";
  const accountsForList = isAllAccountsMode
    ? allAccounts
    : allAccounts.filter((a) => a.email !== activeAccount?.email);

  const handleLock = async () => {
    // Clear React Native session (in-memory cache)
    if (storage.lockAllAccounts) {
      await storage.lockAllAccounts();
    } else {
      await storage.clearSession();
    }

    // IMPORTANT: Clear MUK from native VaultStateManager for autofill security
    // Without this, autofill will still work even when app is locked!
    if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
      const wasUnlocked = CredentialProvider.isVaultUnlocked();
      CredentialProvider.clearAllMasterUnlockKeys();
      const isNowUnlocked = CredentialProvider.isVaultUnlocked();
      console.log(
        `[Lock] Vault was unlocked: ${wasUnlocked}, now unlocked: ${isNowUnlocked}`,
      );
    }

    router.replace("/(auth)/unlock");
  };

  const handleSignOut = async () => {
    const title = isAllAccountsMode ? "Sign Out All Accounts" : "Sign Out";
    const description = isAllAccountsMode
      ? "This will remove all accounts from this device. You'll need your Secret Key(s) to sign in again."
      : "This will remove your account from this device. You'll need your Secret Key to sign in again.";

    Alert.alert(title, description, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          if (isAllAccountsMode) {
            for (const account of allAccounts) {
              await removeAccount(account.email);
            }
          } else if (activeAccount) {
            await removeAccount(activeAccount.email);
          }
          await refreshAccounts();
          router.replace("/(auth)/login");
        },
      },
    ]);
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
          <Card.Title className="flex-1 text-xl">Settings</Card.Title>
        </View>
      </View>

      <ScrollView className="flex-1 px-2.5">
        {/* Account Section */}
        <Surface variant="secondary" className="mb-6 gap-0 p-0">
          <Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
            Account
          </Text>
          <SettingRow
            icon={StyledUser}
            label={accountLabel}
            value={accountValue}
          />
          <SettingRow icon={StyledServer} label="Server" value={serverValue} />
        </Surface>

        {/* Appearance Section */}
        <Surface variant="secondary" className="mb-6 gap-0 p-0">
          <Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
            Appearance
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
              <Label>Dark Mode</Label>
              <Description>
                {theme === "dark" ? "Enabled" : "Disabled"}
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
            Security
          </Text>
          <Text className="px-4 pb-2 text-muted text-xs">
            Applies to all accounts on this device
          </Text>
          {biometricAvailable && (
            <ControlField
              isSelected={biometricEnabled}
              onSelectedChange={handleBiometricToggle}
              className="px-4 py-4"
            >
              <View className="mr-4 h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                {biometricType === "Face ID" ? (
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
                <Label>{biometricType || "Biometric"} Unlock</Label>
                <Description>
                  {biometricEnabled ? "Enabled" : "Disabled"}
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
          )}

          {/* Show notice if hardware exists but no biometrics enrolled */}
          {biometricDetails.hasHardware && !biometricDetails.isEnrolled && (
            <View className="px-4 py-4">
              <Card variant="secondary" className="gap-2 bg-amber-50 p-3">
                <View className="flex-row items-start gap-3">
                  <StyledAlertCircle size={18} className="text-amber-600" />
                  <View className="flex-1">
                    <Card.Title className="text-amber-800 text-sm">
                      Set Up Biometric
                    </Card.Title>
                    <Card.Description className="text-amber-700 text-xs">
                      Enable Face ID or Touch ID in your device settings to use
                      biometric unlock.
                    </Card.Description>
                  </View>
                </View>
              </Card>
            </View>
          )}

          <SettingRow
            icon={StyledClock}
            label="Auto-Lock"
            value={getAutoLockLabel(autoLockTimeout)}
            onPress={handleAutoLockChange}
          />

          {/* Master password re-entry info */}
          {biometricEnabled && masterPasswordDaysRemaining !== null && (
            <View className="px-4 py-4">
              <Card className="gap-2 p-3 bg-accent-soft text-accent-soft-foreground">
                <View className="flex-row items-center gap-3">
                  <StyledLock
                    size={18}
                    className="text-accent-soft-foreground"
                  />
                  <View className="flex-1">
                    <Card.Title className="text-sm text-accent-soft-foreground">
                      Password Check
                    </Card.Title>
                    <Card.Description className="text-accent-soft-foreground text-xs">
                      {masterPasswordDaysRemaining > 0
                        ? `Master password required in ${masterPasswordDaysRemaining} days for security verification.`
                        : "Master password required on next unlock for security verification."}
                    </Card.Description>
                  </View>
                </View>
              </Card>
            </View>
          )}

          <SettingRow
            icon={StyledLock}
            label="Lock Vault"
            onPress={handleLock}
          />
        </Surface>

        {/* Accessibility Section */}
        <Surface variant="secondary" className="mb-6 gap-0 p-0">
          <Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
            Accessibility
          </Text>

          <View className="px-4 py-4">
            <View className="gap-2 p-3">
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
            </View>
          </View>
        </Surface>

        {/* Multiple Accounts */}
        {accountsForList.length > 0 && (
          <Surface variant="secondary" className="mb-6 gap-0 p-0">
            <Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
              {isAllAccountsMode ? "Accounts" : "Other Accounts"}
            </Text>
            {accountsForList.map((account) => (
              <View key={account.email}>
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
        )}

        {/* Danger Zone */}
        <Surface variant="secondary" className="mb-6 gap-0 p-0">
          <Text className="px-4 pt-5 pb-2 font-semibold text-sm text-surface-foreground uppercase">
            Danger Zone
          </Text>
          <SettingRow
            icon={StyledLogOut}
            label={isAllAccountsMode ? "Sign Out All" : "Sign Out"}
            value={
              isAllAccountsMode
                ? "Remove all accounts from device"
                : "Remove this account from device"
            }
            onPress={handleSignOut}
            destructive
          />
        </Surface>

        {/* App Info */}
        <View className="items-center gap-1 py-8">
          <Text className="text-sm text-surface-foreground">
            Bittery Mobile
          </Text>
          <Text className="text-surface-foreground text-xs">Version 0.1.0</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
