import {
	useAllVaultKeys,
	useItemCounts,
	useItems,
	type VaultKeyWithAccount,
} from "@bittery/core/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { PressableFeedback, Skeleton, useToast } from "heroui-native";
import { useCallback, useMemo, useState } from "react";
import { FlatList, RefreshControl, Text, View } from "react-native";
import {
	AppBar,
	EmptyState,
	IconChevronRight,
	IconPlus,
	IconTag,
	IconVault,
	iconSize,
	layout,
	Screen,
	SectionLabel,
	Segmented,
	type SegmentedOption,
	useBottomInset,
} from "@/components/ui";
import { VaultListItem } from "@/components/vault-list-item";
import { getTagColorFromName } from "@/lib/tag-color";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";

type BrowseSegment = "vaults" | "tags";

type VaultRow =
	| { type: "header"; kind: "personal" | "shared"; count: number }
	| {
			type: "vault";
			vault: VaultKeyWithAccount;
			itemCount: number;
			isFirst: boolean;
			isLast: boolean;
	  };

interface TagRow {
	name: string;
	count: number;
}

export default function BrowseScreen() {
	const { m } = useI18n();
	const router = useRouter();
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const params = useLocalSearchParams<{ browse?: string }>();
	const bottomInset = useBottomInset({ tabBar: true });

	const [segment, setSegment] = useState<BrowseSegment>("vaults");
	const [appliedParam, setAppliedParam] = useState<string | undefined>();
	const [refreshing, setRefreshing] = useState(false);

	// `(tabs)/tags` redirects here with `?browse=tags`; honour it without an effect.
	if (params.browse !== appliedParam) {
		setAppliedParam(params.browse);
		if (params.browse === "tags" || params.browse === "vaults") {
			setSegment(params.browse);
		}
	}

	const { vaultKeys, isLoading } = useAllVaultKeys();
	const { items } = useItems();
	const counts = useItemCounts(items);

	const segments = useMemo<SegmentedOption<BrowseSegment>[]>(
		() => [
			{ value: "vaults", label: m.mob_tab_vaults() },
			{ value: "tags", label: m.mob_tab_tags() },
		],
		[m],
	);

	const vaultRows = useMemo<VaultRow[]>(() => {
		const rows: VaultRow[] = [];
		const groups = [
			["personal", vaultKeys.filter((v) => v.vaultType === "personal")],
			["shared", vaultKeys.filter((v) => v.vaultType === "team")],
		] as const;

		for (const [kind, group] of groups) {
			if (group.length === 0) continue;
			rows.push({ type: "header", kind, count: group.length });
			group.forEach((vault, index) => {
				rows.push({
					type: "vault",
					vault,
					itemCount: counts?.byVault[vault.vaultId] ?? 0,
					isFirst: index === 0,
					isLast: index === group.length - 1,
				});
			});
		}

		return rows;
	}, [vaultKeys, counts]);

	const tagRows = useMemo<TagRow[]>(() => {
		const tagCounts = new Map<string, number>();
		for (const item of items) {
			for (const tag of item.tags ?? []) {
				tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
			}
		}
		return Array.from(tagCounts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [items]);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await queryClient.invalidateQueries({ queryKey: ["all-vault-keys"] });
		} finally {
			setRefreshing(false);
		}
	}, [queryClient]);

	const handleCreateVault = () => {
		toast.show({
			variant: "default",
			label: m.mob_vaults_toast_create_title(),
			description: m.mob_vaults_toast_create_description(),
			placement: "bottom",
		});
	};

	const renderVaultRow = useCallback(
		({ item: row }: { item: VaultRow }) => {
			if (row.type === "header") {
				return (
					<View className="px-4 pt-6 pb-2">
						<SectionLabel
							className="px-0 pb-0"
							trailing={
								<Text className="font-semibold text-2xs text-muted">
									{row.count}
								</Text>
							}
						>
							{row.kind === "personal"
								? m.mob_vaults_section_personal()
								: m.mob_vaults_section_team()}
						</SectionLabel>
					</View>
				);
			}

			return (
				<VaultListItem
					id={row.vault.vaultId}
					name={row.vault.vaultName}
					type={row.vault.vaultType}
					role={row.vault.role}
					icon={row.vault.vaultIcon}
					imageUrl={row.vault.vaultImageUrl}
					itemCount={row.itemCount}
					onPress={() => router.push(`/(vault)/${row.vault.vaultId}`)}
					isFirstInSection={row.isFirst}
					isLastInSection={row.isLast}
				/>
			);
		},
		[m, router],
	);

	const renderTagRow = useCallback(
		({ item: tag, index }: { item: TagRow; index: number }) => (
			<View className="px-4">
				<View
					className={cn(
						"overflow-hidden border-border border-x bg-surface",
						index === 0 ? "rounded-t-2xl border-t" : "",
						index === tagRows.length - 1 ? "rounded-b-2xl border-b" : "",
					)}
				>
					{index === 0 ? null : <View className="ml-4 h-px bg-border" />}
					<PressableFeedback
						onPress={() =>
							router.push(`/(tabs)/tags/${encodeURIComponent(tag.name)}`)
						}
						className="flex-row items-center px-4"
						style={{ minHeight: layout.rowHeightCompact }}
					>
						<PressableFeedback.Highlight />
						<View
							aria-hidden
							className="h-[7px] w-[7px] rounded-full"
							style={{ backgroundColor: getTagColorFromName(tag.name) }}
						/>
						<Text
							numberOfLines={1}
							className="ml-3 flex-1 font-medium text-base text-foreground"
						>
							{tag.name}
						</Text>
						<Text className="ml-3 text-muted text-sm">{tag.count}</Text>
						<IconChevronRight
							size={iconSize.row}
							className="ml-1 text-muted opacity-60"
						/>
					</PressableFeedback>
				</View>
			</View>
		),
		[router, tagRows.length],
	);

	return (
		<Screen aurora>
			<AppBar
				largeTitle={m.mob_browse_title()}
				actions={
					segment === "vaults" ? (
						<PressableFeedback
							onPress={handleCreateVault}
							accessibilityLabel={m.mob_vaults_toast_create_title()}
							className="h-9 w-9 items-center justify-center rounded-full"
						>
							<PressableFeedback.Highlight />
							<IconPlus size={iconSize.bar} className="text-foreground" />
						</PressableFeedback>
					) : null
				}
			/>

			<View className="px-4 pb-2.5">
				<Segmented options={segments} value={segment} onChange={setSegment} />
			</View>

			{segment === "vaults" ? (
				isLoading ? (
					<VaultsSkeleton />
				) : (
					<FlatList
						data={vaultRows}
						renderItem={renderVaultRow}
						keyExtractor={(row) =>
							row.type === "header" ? `header-${row.kind}` : row.vault.vaultId
						}
						refreshControl={
							<RefreshControl
								refreshing={refreshing}
								onRefresh={handleRefresh}
							/>
						}
						contentContainerStyle={{ paddingBottom: bottomInset, flexGrow: 1 }}
						ListEmptyComponent={
							<EmptyState
								icon={IconVault}
								title={m.mob_vaults_empty_title()}
								description={m.mob_vaults_empty_description()}
							/>
						}
					/>
				)
			) : (
				<FlatList
					data={tagRows}
					renderItem={renderTagRow}
					keyExtractor={(tag) => tag.name}
					contentContainerStyle={{
						paddingTop: layout.gap.xs,
						paddingBottom: bottomInset,
						flexGrow: 1,
					}}
					ListEmptyComponent={
						<EmptyState
							icon={IconTag}
							title={m.mob_tags_empty_no_tags()}
							description={m.mob_tags_empty_no_tags_description()}
						/>
					}
				/>
			)}
		</Screen>
	);
}

function VaultsSkeleton() {
	return (
		<View className="px-4 pt-6">
			<View className="overflow-hidden rounded-2xl border border-border bg-surface">
				{[0, 1, 2, 3, 4].map((index) => (
					<View key={index}>
						{index > 0 ? <View className="ml-14 h-px bg-border" /> : null}
						<View
							className="flex-row items-center px-3.5"
							style={{ minHeight: layout.rowHeight }}
						>
							<Skeleton className="mr-3 h-10 w-10 rounded-xl" />
							<View className="flex-1 gap-2">
								<Skeleton className="h-3.5 w-28 rounded-full" />
								<Skeleton className="h-3 w-20 rounded-full" />
							</View>
						</View>
					</View>
				))}
			</View>
		</View>
	);
}
