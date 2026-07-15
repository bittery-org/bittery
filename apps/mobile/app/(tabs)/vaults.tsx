import { useAllVaultKeys, type VaultKeyWithAccount } from "@bittery/core/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, useRouter } from "expo-router";
import { Button, Card, Skeleton, useToast } from "heroui-native";
import { Plus, Shield } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import { withUniwind } from "uniwind";
import { SafeAreaView } from "@/components/safe-area-view";
import { useI18n } from "@/providers/i18n-provider";
import { VaultListItem } from "../../src/components/vault-list-item";

// Create styled icon components
const StyledPlus = withUniwind(Plus);
const StyledShield = withUniwind(Shield);

type VaultSection =
	| { type: "header"; title: string; count: number }
	| {
			type: "vault";
			item: VaultKeyWithAccount;
			isFirst: boolean;
			isLast: boolean;
	  };

export default function VaultsScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const { toast } = useToast();
	const [refreshing, setRefreshing] = useState(false);
	const queryClient = useQueryClient();

	const { vaultKeys, isLoading } = useAllVaultKeys();

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		} finally {
			setRefreshing(false);
		}
	}, [queryClient]);

	const handleCreateVault = () => {
		// TODO: Navigate to create vault screen when implemented
		toast.show({
			variant: "default",
			label: m.mob_vaults_toast_create_title(),
			description: m.mob_vaults_toast_create_description(),
			placement: "bottom",
		});
	};

	const handleVaultPress = useCallback(
		(vaultId: string) => {
			router.push(`/(vault)/${vaultId}`);
		},
		[router],
	);

	const { personalVaults, teamVaults } = useMemo(() => {
		if (!vaultKeys) {
			return {
				personalVaults: [],
				teamVaults: [],
			};
		}

		const personal = vaultKeys.filter((v) => v.vaultType === "personal");
		const team = vaultKeys.filter((v) => v.vaultType === "team");

		return {
			personalVaults: personal,
			teamVaults: team,
		};
	}, [vaultKeys]);

	const renderSectionHeader = useCallback(
		(title: string, count: number) => (
			<View className="flex-row items-center px-4 pt-4 pb-2">
				<Card.Title className="font-semibold text-muted text-xs uppercase tracking-wide">
					{title} ({count})
				</Card.Title>
			</View>
		),
		[],
	);

	const sections = useMemo(() => {
		if (!vaultKeys || vaultKeys.length === 0) {
			return [];
		}

		const nextSections: VaultSection[] = [];

		if (personalVaults.length > 0) {
			nextSections.push({
				type: "header",
				title: m.mob_vaults_section_personal(),
				count: personalVaults.length,
			});
			for (let i = 0; i < personalVaults.length; i++) {
				nextSections.push({
					type: "vault",
					item: personalVaults[i],
					isFirst: i === 0,
					isLast: i === personalVaults.length - 1,
				});
			}
		}

		if (teamVaults.length > 0) {
			nextSections.push({
				type: "header",
				title: m.mob_vaults_section_team(),
				count: teamVaults.length,
			});
			for (let i = 0; i < teamVaults.length; i++) {
				nextSections.push({
					type: "vault",
					item: teamVaults[i],
					isFirst: i === 0,
					isLast: i === teamVaults.length - 1,
				});
			}
		}

		return nextSections;
	}, [vaultKeys, personalVaults, teamVaults, m]);

	const renderSection = useCallback(
		({ item: section }: { item: VaultSection }) => {
			if (section.type === "header") {
				return renderSectionHeader(section.title, section.count);
			}

			const vault = section.item;
			return (
				<VaultListItem
					id={vault.vaultId}
					name={vault.vaultName}
					type={vault.vaultType}
					role={vault.role}
					icon={vault.vaultIcon}
					imageUrl={vault.vaultImageUrl}
					onPress={() => handleVaultPress(vault.vaultId)}
					isFirstInSection={section.isFirst}
					isLastInSection={section.isLast}
				/>
			);
		},
		[handleVaultPress, renderSectionHeader],
	);

	const keyExtractor = useCallback(
		(item: VaultSection) =>
			item.type === "header" ? `header-${item.title}` : item.item.vaultId,
		[],
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
							{m.mob_vaults_empty_title()}
						</Card.Title>
						<Card.Description className="text-center">
							{m.mob_vaults_empty_description()}
						</Card.Description>
					</Card>
				</View>
			);
		}

		return (
			<FlatList
				data={sections}
				renderItem={renderSection}
				keyExtractor={keyExtractor}
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
