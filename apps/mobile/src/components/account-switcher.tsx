import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Avatar, BottomSheet, PressableFeedback, useToast } from "heroui-native";
import { Check, Lock, Plus, Settings, Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Alert, Text, View } from "react-native";

import { useAccount } from "../contexts/account-context";
import { type AccountMetadata, storage } from "../services/storage";

export function AccountSwitcher() {
	const router = useRouter();
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const { allAccounts, activeAccount, switchAccount } = useAccount();
	const [switching, setSwitching] = useState(false);
	const [isOpen, setIsOpen] = useState(false);

	const handleAccountSwitch = async (account: AccountMetadata) => {
		if (account.email === activeAccount?.email) {
			setIsOpen(false);
			return;
		}

		setSwitching(true);
		try {
			// Clear query cache before switching
			queryClient.clear();

			// Switch account
			await switchAccount(account.email);

			// Check if the new account has a valid session
			const isValid = await storage.isSessionValid(account.email);

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
				label: "Failed to switch account. Please try again.",
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
			"Lock Vault",
			"This will lock your vault. You'll need to enter your password to unlock.",
			[
				{ text: "Cancel", style: "cancel" },
				{
					text: "Lock",
					style: "destructive",
					onPress: async () => {
						await storage.clearSession();
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
						color="accent"
						alt={activeAccount?.name || activeAccount?.email || "Account"}
					>
						{activeAccount?.teamAvatarUrl && (
							<Avatar.Image source={{ uri: activeAccount.teamAvatarUrl }} />
						)}
						<Avatar.Fallback>
							<Text className="font-semibold text-xs">
								{getInitials(activeAccount)}
							</Text>
						</Avatar.Fallback>
					</Avatar>
				</View>
			</BottomSheet.Trigger>
			<BottomSheet.Portal>
				<BottomSheet.Overlay />
				<BottomSheet.Content>
					<View className="items-center py-3">
						<BottomSheet.Title>Accounts</BottomSheet.Title>
					</View>

					{/* Account list */}
					<View className="border-border border-b">
						{allAccounts.map((account) => {
							const isActive =
								account.email.toLowerCase() ===
								activeAccount?.email.toLowerCase();
							return (
								<PressableFeedback
									key={account.email}
									onPress={() => handleAccountSwitch(account)}
									isDisabled={switching}
									className={`flex-row items-center px-4 py-3 ${
										isActive ? "bg-primary/5" : ""
									}`}
								>
									<PressableFeedback.Highlight />
									{/* Avatar with team image support */}
									<View className="mr-3">
										<Avatar
											size="md"
											color="accent"
											alt={account.name || account.email}
										>
											{account.teamAvatarUrl && (
												<Avatar.Image source={{ uri: account.teamAvatarUrl }} />
											)}
											<Avatar.Fallback>
												<Text className="font-semibold text-xs">
													{getInitials(account)}
												</Text>
											</Avatar.Fallback>
										</Avatar>
									</View>

									{/* Info */}
									<View className="flex-1">
										{account.name && (
											<Text className="font-medium text-foreground">
												{account.name}
											</Text>
										)}
										<Text
											className={
												account.name
													? "text-muted-foreground text-sm"
													: "font-medium text-foreground"
											}
										>
											{account.email}
										</Text>
										{account.teamName && (
											<Text className="text-muted-foreground text-xs">
												{account.teamName}
											</Text>
										)}
									</View>

									{/* Checkmark for active */}
									{isActive && <Check size={20} color="#22c55e" />}
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
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
								<Plus size={20} color="#6b7280" />
							</View>
							<Text className="font-medium text-foreground">Add Account</Text>
						</PressableFeedback>

						{/* Settings */}
						<PressableFeedback
							onPress={handleSettings}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
								<Settings size={20} color="#6b7280" />
							</View>
							<Text className="font-medium text-foreground">Settings</Text>
						</PressableFeedback>

						{/* Trash */}
						<PressableFeedback
							onPress={handleTrash}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
								<Trash2 size={20} color="#6b7280" />
							</View>
							<Text className="font-medium text-foreground">Trash</Text>
						</PressableFeedback>

						{/* Lock Vault */}
						<PressableFeedback
							onPress={handleLockVault}
							className="flex-row items-center rounded-lg py-3"
						>
							<PressableFeedback.Highlight />
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
								<Lock size={20} color="#ef4444" />
							</View>
							<Text className="font-medium text-destructive">Lock Vault</Text>
						</PressableFeedback>
					</View>
				</BottomSheet.Content>
			</BottomSheet.Portal>
		</BottomSheet>
	);
}
