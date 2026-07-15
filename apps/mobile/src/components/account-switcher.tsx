import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
	Avatar,
	BottomSheet,
	PressableFeedback,
	useToast,
} from "heroui-native";
import { Check, Lock, Plus, Settings, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, Platform, Text, View } from "react-native";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import CredentialProvider from "../../modules/credential-provider";
import { useAccount } from "../contexts/account-context";
import { type AccountMetadata, storage } from "../services/storage";

const StyledCheck = withUniwind(Check);
const StyledPlus = withUniwind(Plus);
const StyledSettings = withUniwind(Settings);
const StyledTrash2 = withUniwind(Trash2);
const StyledLock = withUniwind(Lock);

export function AccountSwitcher() {
	const router = useRouter();
	const { toast } = useToast();
	const { m } = useI18n();
	const queryClient = useQueryClient();
	const { allAccounts, activeAccount, activeAccountConfig, switchAccount } =
		useAccount();
	const [switching, setSwitching] = useState(false);
	const [isOpen, setIsOpen] = useState(false);
	const handleAccountSwitch = async (account: AccountMetadata) => {
		if (
			activeAccountConfig?.type === "single" &&
			account.accountId === activeAccountConfig.accountId
		) {
			setIsOpen(false);
			return;
		}

		setSwitching(true);
		try {
			// Clear query cache before switching
			queryClient.clear();

			// Switch account
			await switchAccount(account.accountId);

			// Check if the new account has a valid session
			const isValid = await storage.isSessionValid(account.accountId);

			setIsOpen(false);

			if (isValid) {
				// Has valid session, refresh the current view
				router.replace("/(tabs)");
			} else {
				// No valid session, go to unlock
				router.replace("/(auth)/unlock");
			}
		} catch (error) {
			console.error("Error switching account:", error);
			toast.show({
				variant: "danger",
				label: m.mob_account_switcher_toast_switch_failed(),
				placement: "bottom",
			});
		} finally {
			setSwitching(false);
		}
	};

	const handleAddAccount = () => {
		setIsOpen(false);
		router.push("/(auth)/login");
	};

	const handleSettings = () => {
		setIsOpen(false);
		router.push("/settings");
	};

	const handleTrash = () => {
		setIsOpen(false);
		router.push("/(tabs)/trash");
	};

	const handleLockVault = async () => {
		Alert.alert(
			m.mob_account_switcher_lock_dialog_title(),
			m.mob_account_switcher_lock_dialog_message(),
			[
				{ text: m.mob_account_switcher_lock_dialog_cancel(), style: "cancel" },
				{
					text: m.mob_account_switcher_lock_dialog_confirm(),
					style: "destructive",
					onPress: async () => {
						if (storage.lockAllAccounts) {
							await storage.lockAllAccounts();
						} else {
							await storage.clearSession();
						}

						if (Platform.OS === "android" && CredentialProvider.isAvailable()) {
							CredentialProvider.clearAllMasterUnlockKeys();
						}

						setIsOpen(false);
						router.replace("/(auth)/unlock");
					},
				},
			],
		);
	};

	// Get initials from email or name
	const getInitials = (account?: AccountMetadata | null) => {
		if (!account) return "?";
		if (account.name) {
			const parts = account.name.split(" ");
			if (parts.length >= 2) {
				return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
			}
			return account.name.substring(0, 2).toUpperCase();
		}
		return account.email.substring(0, 2).toUpperCase();
	};

	return (
		<BottomSheet isOpen={isOpen} onOpenChange={setIsOpen}>
			<BottomSheet.Trigger>
				<View className="rounded-full">
					<Avatar
						size="sm"
						alt={activeAccount?.name || activeAccount?.email || "Account"}
					>
						{activeAccount?.teamAvatarUrl && (
							<Avatar.Image source={{ uri: activeAccount.teamAvatarUrl }} />
						)}
						<Avatar.Fallback>{getInitials(activeAccount)}</Avatar.Fallback>
					</Avatar>
				</View>
			</BottomSheet.Trigger>
			<BottomSheet.Portal>
				<BottomSheet.Overlay />
				<BottomSheet.Content>
					<View className="items-center py-3">
						<BottomSheet.Title>
							{m.mob_account_switcher_title()}
						</BottomSheet.Title>
					</View>

					{/* Account list */}
					<View className="pb-4">
						{allAccounts.map((account) => {
							const isActive =
								activeAccountConfig?.type === "single" &&
								account.accountId === activeAccountConfig.accountId;
							return (
								<PressableFeedback
									key={account.accountId}
									onPress={() => handleAccountSwitch(account)}
									isDisabled={switching}
									className={cn(
										"flex-row",
										"items-center",
										"rounded-2xl",
										"px-4",
										"py-3",
										isActive ? "bg-surface-tertiary" : "",
									)}
								>
									<PressableFeedback.Highlight />
									{/* Avatar with team image support */}
									<View className="mr-3">
										<Avatar size="md" alt={account.name || account.email}>
											{account.teamAvatarUrl && (
												<Avatar.Image source={{ uri: account.teamAvatarUrl }} />
											)}
											<Avatar.Fallback>{getInitials(account)}</Avatar.Fallback>
										</Avatar>
									</View>

									{/* Info */}
									<View className="flex-1">
										{account.name && (
											<Text className="font-medium text-foreground">
												{account.name}
											</Text>
										)}
										<Text className="text-muted text-sm">{account.email}</Text>
										{account.teamName && (
											<Text className="text-muted text-xs">
												{account.teamName}
											</Text>
										)}
									</View>

									{/* Checkmark for active */}
									{isActive && (
										<StyledCheck size={20} className="text-success" />
									)}
								</PressableFeedback>
							);
						})}
					</View>

					{/* Actions */}
					<View className="px-4 pt-2 pb-4">
						{/* Add Account */}
						<PressableFeedback
							onPress={handleAddAccount}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-surface-tertiary">
								<StyledPlus size={20} className="text-muted" />
							</View>
							<Text className="font-medium text-foreground">
								{m.mob_account_switcher_add_account()}
							</Text>
						</PressableFeedback>

						{/* Settings */}
						<PressableFeedback
							onPress={handleSettings}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-surface-tertiary">
								<StyledSettings size={20} className="text-muted" />
							</View>
							<Text className="font-medium text-foreground">
								{m.mob_account_switcher_settings()}
							</Text>
						</PressableFeedback>

						{/* Trash */}
						<PressableFeedback
							onPress={handleTrash}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-surface-tertiary">
								<StyledTrash2 size={20} className="text-muted" />
							</View>
							<Text className="font-medium text-foreground">
								{m.mob_account_switcher_trash()}
							</Text>
						</PressableFeedback>

						{/* Lock Vault */}
						<PressableFeedback
							onPress={handleLockVault}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-danger/10">
								<StyledLock size={20} className="text-danger" />
							</View>
							<Text className="font-medium text-danger">
								{m.mob_account_switcher_lock_vault()}
							</Text>
						</PressableFeedback>
					</View>
				</BottomSheet.Content>
			</BottomSheet.Portal>
		</BottomSheet>
	);
}
