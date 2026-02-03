import { useQuery } from "@tanstack/react-query";
import type { inferOutput } from "@trpc/tanstack-react-query";
import { Tabs, useRouter } from "expo-router";
import { Button, Card, Skeleton, useToast } from "heroui-native";
import { Plus, Shield } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { VaultListItem } from "../../src/components/vault-list-item";

import { useTRPC } from "../../src/lib/trpc";

// Create styled icon components
const StyledPlus = withUniwind(Plus);
const StyledShield = withUniwind(Shield);

export default function VaultsScreen() {
	const router = useRouter();
	const { toast } = useToast();
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
		toast.show({
			variant: "default",
			label: "Create Vault",
			description: "Vault creation is coming soon. For now, create vaults from the web app.",
			placement: "bottom",
		});
	};

	const handleVaultPress = (vaultId: string) => {
		router.push(`/(vault)/${vaultId}`);
	};

	// Separate personal and team vaults
	const { personalVaults, teamVaults } = useMemo(() => {
		if (!vaultKeys) return { personalVaults: [], teamVaults: [] };

		const personal = vaultKeys.filter((v) => v.type === "personal");
		const team = vaultKeys.filter((v) => v.type === "team");

		return { personalVaults: personal, teamVaults: team };
	}, [vaultKeys]);

	const renderVaultItem = ({
		item,
		isFirst,
		isLast,
	}: {
		item: inferOutput<typeof trpc.vault.list>[number];
		isFirst: boolean;
		isLast: boolean;
	}) => (
		<VaultListItem
			id={item.id}
			name={item.name}
			type={item.type}
			role={item.role}
			icon={item.icon}
			imageUrl={item.imageUrl}
			itemCount={item.items?.length}
			onPress={() => handleVaultPress(item.id)}
			isFirstInSection={isFirst}
			isLastInSection={isLast}
		/>
	);

	const renderSectionHeader = (title: string, count: number) => (
		<View className="flex-row items-center px-4 pt-4 pb-2">
			<Card.Title className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
				{title} ({count})
			</Card.Title>
		</View>
	);

	const renderListContent = () => {
		if (!vaultKeys || vaultKeys.length === 0) {
			return (
				<View className="flex-1 items-center justify-center p-8">
					<Card
						variant="secondary"
						className="w-full max-w-sm items-center p-8"
					>
						<StyledShield size={48} className="mb-4 text-muted" />
						<Card.Title className="mb-2 text-center text-lg">
							No vaults yet
						</Card.Title>
						<Card.Description className="text-center">
							Create a vault to start storing your passwords
						</Card.Description>
					</Card>
				</View>
			);
		}

		// Combine sections into a single data array
		const sections: Array<
			| { type: "header"; title: string; count: number }
			| {
					type: "vault";
					item: inferOutput<typeof trpc.vault.list>[number];
					isFirst: boolean;
					isLast: boolean;
			  }
		> = [];

		if (personalVaults.length > 0) {
			sections.push({
				type: "header",
				title: "Personal Vaults",
				count: personalVaults.length,
			});
			for (let i = 0; i < personalVaults.length; i++) {
				sections.push({
					type: "vault",
					item: personalVaults[i],
					isFirst: i === 0,
					isLast: i === personalVaults.length - 1,
				});
			}
		}

		if (teamVaults.length > 0) {
			sections.push({
				type: "header",
				title: "Team Vaults",
				count: teamVaults.length,
			});
			for (let i = 0; i < teamVaults.length; i++) {
				sections.push({
					type: "vault",
					item: teamVaults[i],
					isFirst: i === 0,
					isLast: i === teamVaults.length - 1,
				});
			}
		}

		return (
			<FlatList
				data={sections}
				renderItem={({ item: section }) => {
					if (section.type === "header") {
						return renderSectionHeader(section.title, section.count);
					}
					return renderVaultItem({
						item: section.item,
						isFirst: section.isFirst,
						isLast: section.isLast,
					});
				}}
				keyExtractor={(item, _index) =>
					item.type === "header" ? `header-${item.title}` : item.item.id
				}
				refreshControl={
					<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
				}
				style={{ flex: 1 }}
				contentContainerStyle={{ paddingTop: 8, paddingBottom: 8, flexGrow: 1 }}
			/>
		);
	};

	const renderSkeletonItem = (index: number) => (
		<Card key={index} className="mx-4 mb-2">
			<Card.Body className="flex-row items-center py-3">
				<Skeleton className="mr-3 h-10 w-10 rounded-lg" />
				<View className="flex-1">
					<Skeleton className="mb-2 h-4 w-32 rounded" />
					<Skeleton className="h-3 w-24 rounded" />
				</View>
			</Card.Body>
		</Card>
	);

	if (isLoading) {
		return (
			<SafeAreaView className="flex-1 bg-background" edges={[]}>
				{/* Skeleton items */}
				<View className="flex-1 py-2">
					{[1, 2, 3, 4, 5, 6].map(renderSkeletonItem)}
				</View>
			</SafeAreaView>
		);
	}

	return (
		<>
			<Tabs.Screen
				options={{
					headerRight: () => (
						<Button
							isIconOnly
							variant="primary"
							size="sm"
							onPress={handleCreateVault}
							className="mr-4"
						>
							<StyledPlus size={18} className="text-accent-foreground" />
						</Button>
					),
				}}
			/>
			<SafeAreaView className="flex-1 bg-background" edges={[]}>
				{/* Vaults List */}
				<View className="flex-1">{renderListContent()}</View>
			</SafeAreaView>
		</>
	);
}
