import { useQuery } from "@tanstack/react-query";
import type { inferOutput } from "@trpc/tanstack-react-query";
import { Tabs, useRouter } from "expo-router";
import { ChevronRight, Plus, Shield, Users } from "lucide-react-native";
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
import { SafeAreaView } from "@/components/safe-area-view";

import { useTRPC } from "../../src/lib/trpc";

export default function VaultsScreen() {
	const router = useRouter();
	const [refreshing, setRefreshing] = useState(false);
	const trpc = useTRPC();

	const {
		data: vaultKeys,
		isLoading,
		refetch,
	} = useQuery(trpc.vault.list.queryOptions());

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await refetch();
		} finally {
			setRefreshing(false);
		}
	};

	const handleCreateVault = () => {
		// TODO: Navigate to create vault screen when implemented
		Alert.alert(
			"Create Vault",
			"Vault creation is coming soon. For now, create vaults from the web app.",
		);
	};

	const renderVaultItem = ({
		item,
	}: {
		item: inferOutput<typeof trpc.vault.list>[number];
	}) => (
		<TouchableOpacity
			onPress={() => router.push(`/(vault)/${item.id}`)}
			className="flex-row items-center border-border border-b px-4 py-4"
			activeOpacity={0.7}
		>
			<View
				className={`mr-4 h-12 w-12 items-center justify-center rounded-xl ${
					item.type === "team" ? "bg-blue-100" : "bg-primary/10"
				}`}
			>
				{item.type === "team" ? (
					<Users size={24} color="#3b82f6" />
				) : (
					<Shield size={24} color="#000" />
				)}
			</View>
			<View className="flex-1">
				<Text className="font-semibold text-foreground">{item.name}</Text>
				<Text className="text-muted-foreground text-sm">
					{item.type === "team" ? "Team vault" : "Personal vault"} • {item.role}
				</Text>
			</View>
			<ChevronRight size={20} color="#9ca3af" />
		</TouchableOpacity>
	);

	if (isLoading) {
		return (
			<SafeAreaView
				className="flex-1 items-center justify-center bg-background"
				edges={["bottom"]}
			>
				<ActivityIndicator size="large" color="#000" />
			</SafeAreaView>
		);
	}

	return (
		<>
			<Tabs.Screen
				options={{
					headerRight: () => (
						<TouchableOpacity
							onPress={handleCreateVault}
							className="mr-4 rounded-full bg-primary p-2"
						>
							<Plus size={18} color="#fff" />
						</TouchableOpacity>
					),
				}}
			/>
			<SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
				{/* Vault List */}
				<FlatList
					data={vaultKeys}
					renderItem={renderVaultItem}
					keyExtractor={(item) => item.id}
					refreshControl={
						<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
					}
					ListEmptyComponent={
						<View className="flex-1 items-center justify-center p-8">
							<Shield size={48} color="#9ca3af" />
							<Text className="mt-4 text-center font-semibold text-foreground text-lg">
								No vaults
							</Text>
							<Text className="mt-2 text-center text-muted-foreground">
								Create a vault to start storing your passwords
							</Text>
						</View>
					}
				/>
			</SafeAreaView>
		</>
	);
}
