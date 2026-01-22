import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
	ChevronRight,
	CreditCard,
	FileText,
	Key,
	LogOut,
	Plus,
	Settings,
	Shield,
	User,
	Users,
} from "lucide-react-native";
import { useState } from "react";
import {
	ActivityIndicator,
	Alert,
	FlatList,
	RefreshControl,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAccount } from "../../src/contexts/account-context";
import { useTRPC } from "../../src/lib/trpc";
import * as storage from "../../src/services/storage";

interface VaultKeyData {
	vaultId: string;
	vaultName: string;
	vaultType: "personal" | "team";
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

export default function VaultListScreen() {
	const router = useRouter();
	const { activeAccount, refreshAccounts } = useAccount();
	const [refreshing, setRefreshing] = useState(false);
	const trpc = useTRPC();

	// Fetch vaults from storage (already cached during login)
	const { data: vaultKeys, isLoading, refetch } = useQuery(trpc.vault.list.queryOptions());

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const handleLogout = async () => {
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
						router.replace("/(auth)/unlock");
					},
				},
			],
		);
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
							await storage.clearAllStoredData(activeAccount.email);
						}
						await refreshAccounts();
						router.replace("/(auth)/login");
					},
				},
			],
		);
	};

	const getCategoryIcon = (category: string) => {
		switch (category) {
			case "login":
				return Key;
			case "credit-card":
				return CreditCard;
			case "identity":
				return User;
			case "secure-note":
				return FileText;
			default:
				return Shield;
		}
	};

	const renderVaultItem = ({
		item,
	}: { item: VaultKeyData & { itemCount?: number } }) => (
		<TouchableOpacity
			onPress={() => router.push(`/(vault)/${item.vaultId}`)}
			className="flex-row items-center border-b border-border px-4 py-4"
		>
			<View
				className={`mr-4 h-12 w-12 items-center justify-center rounded-xl ${
					item.vaultType === "team" ? "bg-blue-100" : "bg-primary/10"
				}`}
			>
				{item.vaultType === "team" ? (
					<Users size={24} color="#3b82f6" />
				) : (
					<Shield size={24} color="#000" />
				)}
			</View>
			<View className="flex-1">
				<Text className="font-semibold text-foreground">{item.vaultName}</Text>
				<Text className="text-sm text-muted-foreground">
					{item.vaultType === "team" ? "Team vault" : "Personal vault"} •{" "}
					{item.role}
				</Text>
			</View>
			<ChevronRight size={20} color="#9ca3af" />
		</TouchableOpacity>
	);

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 items-center justify-center bg-background">
				<ActivityIndicator size="large" color="#000" />
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView className="flex-1 bg-background">
			{/* Header */}
			<View className="flex-row items-center justify-between border-b border-border px-4 py-4">
				<View>
					<Text className="text-2xl font-bold text-foreground">Vaults</Text>
					{activeAccount && (
						<Text className="text-sm text-muted-foreground">
							{activeAccount.email}
						</Text>
					)}
				</View>
				<View className="flex-row items-center gap-2">
					<TouchableOpacity
						onPress={() => router.push("/settings")}
						className="rounded-full bg-secondary p-2"
					>
						<Settings size={20} color="#6b7280" />
					</TouchableOpacity>
					<TouchableOpacity
						onPress={handleLogout}
						className="rounded-full bg-secondary p-2"
					>
						<LogOut size={20} color="#6b7280" />
					</TouchableOpacity>
				</View>
			</View>

			{/* Vault List */}
			<FlatList
				data={vaultKeys}
				renderItem={renderVaultItem}
				keyExtractor={(item) => item.vaultId}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
				}
				ListEmptyComponent={
					<View className="flex-1 items-center justify-center p-8">
						<Shield size={48} color="#9ca3af" />
						<Text className="mt-4 text-center text-lg font-semibold text-foreground">
							No vaults
						</Text>
						<Text className="mt-2 text-center text-muted-foreground">
							Create a vault to start storing your passwords
						</Text>
					</View>
				}
			/>

			{/* Quick Actions */}
			<View className="border-t border-border p-4">
				<TouchableOpacity
					onPress={handleSignOut}
					className="flex-row items-center justify-center rounded-lg bg-destructive/10 py-3"
				>
					<LogOut size={18} color="#ef4444" />
					<Text className="ml-2 font-medium text-destructive">
						Sign out from this device
					</Text>
				</TouchableOpacity>
			</View>
		</SafeAreaView>
	);
}
