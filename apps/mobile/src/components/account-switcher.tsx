import type { AccountMetadata } from "@bittery/crypto/storage-react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Check, Lock, Plus, Settings, Trash2, X } from "lucide-react-native";
import { useState } from "react";
import {
	Alert,
	Modal,
	Pressable,
	Text,
	TouchableOpacity,
	View,
} from "react-native";

import { useAccount } from "../contexts/account-context";
import * as storage from "../services/storage";

interface AccountSwitcherProps {
	visible: boolean;
	onClose: () => void;
}

export function AccountSwitcher({ visible, onClose }: AccountSwitcherProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { allAccounts, activeAccount, switchAccount } = useAccount();
	const [switching, setSwitching] = useState(false);

	const handleAccountSwitch = async (account: AccountMetadata) => {
		if (account.email === activeAccount?.email) {
			onClose();
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

			onClose();

			if (isValid) {
				// Has valid session, refresh the current view
				router.replace("/(tabs)");
			} else {
				// No valid session, go to unlock
				router.replace("/(auth)/unlock");
			}
		} catch (error) {
			console.error("Error switching account:", error);
			Alert.alert("Error", "Failed to switch account. Please try again.");
		} finally {
			setSwitching(false);
		}
	};

	const handleAddAccount = () => {
		onClose();
		router.push("/(auth)/login");
	};

	const handleSettings = () => {
		onClose();
		router.push("/settings");
	};

	const handleTrash = () => {
		onClose();
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
						onClose();
						router.replace("/(auth)/unlock");
					},
				},
			],
		);
	};

	// Get initials from email or name
	const getInitials = (account: AccountMetadata) => {
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
		<Modal
			visible={visible}
			transparent
			animationType="slide"
			onRequestClose={onClose}
		>
			<Pressable className="flex-1 justify-end bg-black/50" onPress={onClose}>
				<Pressable
					className="rounded-t-3xl bg-background pb-8"
					onPress={(e) => e.stopPropagation()}
				>
					{/* Handle bar */}
					<View className="items-center py-3">
						<View className="h-1 w-10 rounded-full bg-muted" />
					</View>

					{/* Header */}
					<View className="flex-row items-center justify-between border-border border-b px-4 pb-3">
						<Text className="font-semibold text-foreground text-lg">
							Accounts
						</Text>
						<TouchableOpacity
							onPress={onClose}
							className="rounded-full bg-secondary p-2"
						>
							<X size={18} color="#6b7280" />
						</TouchableOpacity>
					</View>

					{/* Account list */}
					<View className="border-border border-b">
						{allAccounts.map((account) => {
							const isActive =
								account.email.toLowerCase() ===
								activeAccount?.email.toLowerCase();
							return (
								<TouchableOpacity
									key={account.email}
									onPress={() => handleAccountSwitch(account)}
									disabled={switching}
									className={`flex-row items-center px-4 py-3 ${
										isActive ? "bg-primary/5" : ""
									}`}
									activeOpacity={0.7}
								>
									{/* Avatar */}
									<View
										className={`mr-3 h-10 w-10 items-center justify-center rounded-full ${
											isActive ? "bg-primary" : "bg-secondary"
										}`}
									>
										<Text
											className={`font-semibold ${
												isActive ? "text-primary-foreground" : "text-foreground"
											}`}
										>
											{getInitials(account)}
										</Text>
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
									</View>

									{/* Checkmark for active */}
									{isActive && <Check size={20} color="#22c55e" />}
								</TouchableOpacity>
							);
						})}
					</View>

					{/* Actions */}
					<View className="px-4 pt-2">
						{/* Add Account */}
						<TouchableOpacity
							onPress={handleAddAccount}
							className="flex-row items-center py-3"
							activeOpacity={0.7}
						>
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
								<Plus size={20} color="#6b7280" />
							</View>
							<Text className="font-medium text-foreground">Add Account</Text>
						</TouchableOpacity>

						{/* Settings */}
						<TouchableOpacity
							onPress={handleSettings}
							className="flex-row items-center py-3"
							activeOpacity={0.7}
						>
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
								<Settings size={20} color="#6b7280" />
							</View>
							<Text className="font-medium text-foreground">Settings</Text>
						</TouchableOpacity>

						{/* Trash */}
						<TouchableOpacity
							onPress={handleTrash}
							className="flex-row items-center py-3"
							activeOpacity={0.7}
						>
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-secondary">
								<Trash2 size={20} color="#6b7280" />
							</View>
							<Text className="font-medium text-foreground">Trash</Text>
						</TouchableOpacity>

						{/* Lock Vault */}
						<TouchableOpacity
							onPress={handleLockVault}
							className="flex-row items-center py-3"
							activeOpacity={0.7}
						>
							<View className="mr-3 h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
								<Lock size={20} color="#ef4444" />
							</View>
							<Text className="font-medium text-destructive">Lock Vault</Text>
						</TouchableOpacity>
					</View>
				</Pressable>
			</Pressable>
		</Modal>
	);
}

// Avatar button component for headers
interface AccountAvatarButtonProps {
	onPress: () => void;
}

export function AccountAvatarButton({ onPress }: AccountAvatarButtonProps) {
	const { activeAccount } = useAccount();

	const getInitials = () => {
		if (!activeAccount) return "?";
		if (activeAccount.name) {
			const parts = activeAccount.name.split(" ");
			if (parts.length >= 2) {
				return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
			}
			return activeAccount.name.substring(0, 2).toUpperCase();
		}
		return activeAccount.email.substring(0, 2).toUpperCase();
	};

	return (
		<TouchableOpacity
			onPress={onPress}
			className="size-9 items-center justify-center rounded-full bg-primary"
			activeOpacity={0.7}
		>
			<Text className="font-semibold text-primary-foreground text-xs">
				{getInitials()}
			</Text>
		</TouchableOpacity>
	);
}
