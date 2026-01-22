import { useRouter } from "expo-router";
import {
	ArrowLeft,
	ChevronRight,
	Clock,
	Fingerprint,
	Lock,
	LogOut,
	Server,
	Trash2,
	User,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
	Alert,
	ScrollView,
	Switch,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAccount } from "../../src/contexts/account-context";
import * as storage from "../../src/services/storage";

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

	const [biometricAvailable, setBiometricAvailable] = useState(false);
	const [biometricEnabled, setBiometricEnabled] = useState(false);
	const [biometricType, setBiometricType] = useState<string | null>(null);
	const [autoLockTimeout, setAutoLockTimeout] = useState<number>(
		10 * 60 * 1000,
	);
	const [serverUrl, setServerUrl] = useState<string | null>(null);

	const loadSettings = useCallback(async () => {
		if (!activeAccount) return;

		const available = await storage.isBiometricAvailable();
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

	const handleLock = async () => {
		await storage.clearSession();
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

	const SettingRow = ({
		icon: Icon,
		label,
		value,
		onPress,
		rightElement,
		destructive,
	}: {
		icon: typeof Lock;
		label: string;
		value?: string;
		onPress?: () => void;
		rightElement?: React.ReactNode;
		destructive?: boolean;
	}) => (
		<TouchableOpacity
			onPress={onPress}
			disabled={!onPress && !rightElement}
			className="flex-row items-center border-border border-b px-4 py-4"
		>
			<View
				className={`mr-4 h-10 w-10 items-center justify-center rounded-lg ${
					destructive ? "bg-destructive/10" : "bg-secondary"
				}`}
			>
				<Icon size={20} color={destructive ? "#ef4444" : "#6b7280"} />
			</View>
			<View className="flex-1">
				<Text
					className={`font-medium ${
						destructive ? "text-destructive" : "text-foreground"
					}`}
				>
					{label}
				</Text>
				{value && (
					<Text className="text-muted-foreground text-sm">{value}</Text>
				)}
			</View>
			{rightElement || (onPress && <ChevronRight size={20} color="#9ca3af" />)}
		</TouchableOpacity>
	);

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="flex-row items-center border-border border-b px-4 py-4">
				<TouchableOpacity
					onPress={() => router.back()}
					className="mr-3 rounded-full bg-secondary p-2"
				>
					<ArrowLeft size={20} color="#6b7280" />
				</TouchableOpacity>
				<Text className="font-bold text-foreground text-xl">Settings</Text>
			</View>

			<ScrollView className="flex-1">
				{/* Account Section */}
				<View className="mb-6">
					<Text className="px-4 py-3 font-semibold text-muted-foreground text-sm uppercase">
						Account
					</Text>
					<SettingRow
						icon={User}
						label={activeAccount?.name || "Account"}
						value={activeAccount?.email}
					/>
					<SettingRow
						icon={Server}
						label="Server"
						value={serverUrl || "Not set"}
					/>
				</View>

				{/* Security Section */}
				<View className="mb-6">
					<Text className="px-4 py-3 font-semibold text-muted-foreground text-sm uppercase">
						Security
					</Text>
					{biometricAvailable && (
						<SettingRow
							icon={Fingerprint}
							label={`${biometricType || "Biometric"} Unlock`}
							value={biometricEnabled ? "Enabled" : "Disabled"}
							rightElement={
								<Switch
									value={biometricEnabled}
									onValueChange={handleBiometricToggle}
								/>
							}
						/>
					)}
					<SettingRow
						icon={Clock}
						label="Auto-Lock"
						value={getAutoLockLabel(autoLockTimeout)}
						onPress={handleAutoLockChange}
					/>
					<SettingRow icon={Lock} label="Lock Vault" onPress={handleLock} />
				</View>

				{/* Multiple Accounts */}
				{allAccounts.length > 1 && (
					<View className="mb-6">
						<Text className="px-4 py-3 font-semibold text-muted-foreground text-sm uppercase">
							Other Accounts
						</Text>
						{allAccounts
							.filter((a) => a.email !== activeAccount?.email)
							.map((account) => (
								<SettingRow
									key={account.email}
									icon={User}
									label={account.name || account.email.split("@")[0]}
									value={account.email}
									onPress={() => handleRemoveAccount(account.email)}
									rightElement={
										<TouchableOpacity
											onPress={() => handleRemoveAccount(account.email)}
											className="p-2"
										>
											<Trash2 size={18} color="#ef4444" />
										</TouchableOpacity>
									}
								/>
							))}
					</View>
				)}

				{/* Danger Zone */}
				<View className="mb-6">
					<Text className="px-4 py-3 font-semibold text-muted-foreground text-sm uppercase">
						Danger Zone
					</Text>
					<SettingRow
						icon={LogOut}
						label="Sign Out"
						value="Remove this account from device"
						onPress={handleSignOut}
						destructive
					/>
				</View>

				{/* App Info */}
				<View className="items-center py-8">
					<Text className="text-muted-foreground text-sm">Bittery Mobile</Text>
					<Text className="text-muted-foreground text-xs">Version 0.1.0</Text>
				</View>
			</ScrollView>
		</SafeAreaView>
	);
}
