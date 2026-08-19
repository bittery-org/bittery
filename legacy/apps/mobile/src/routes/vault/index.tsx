/**
 * Browse — the second of the three tabs (DESIGN-NATIVE.md § Information architecture). A
 * segmented control over two ways into the same items: by vault, or by tag. Ported from
 * `apps/mobile/app/(tabs)/vaults.tsx`.
 *
 * This screen used to be the app's landing screen and carried the account email, a loose Lock
 * button and a "+". Lock and the account now live in the account sheet, which `TabScreen` renders,
 * and creating an item is the FAB.
 *
 * than in `src/components/vault/` only because this redesign's file scope did not include a new
 * component module. Move it there when convenient.
 */

import { useAllVaultKeys, useItemCounts, useItems } from "@bittery/core/hooks";
import { IconPlus, IconTag, IconVault } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	BarButton,
	EmptyState,
	Fab,
	iconClass,
	ListCard,
	ListRow,
	SectionLabel,
	Segmented,
} from "@/components/ui";
import { CreateItemSheet } from "@/components/vault/create-item-sheet";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { TabScreen } from "@/components/vault/tab-screen";
import { TagListCard, type TagRow } from "@/components/vault/tag-list";
import { CreateVaultSheet } from "@/components/vault/vault-form-sheet";
import { VaultTile } from "@/components/vault/vault-tile";
import { useCreateItemFlow } from "@/hooks/use-create-item-flow";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/")({
	component: BrowseScreen,
});

type BrowseSegment = "vaults" | "tags";

function BrowseScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const [segment, setSegment] = useState<BrowseSegment>("vaults");
	const [isCreateVaultOpen, setIsCreateVaultOpen] = useState(false);

	const { vaultKeys, isLoading: isLoadingVaults } = useAllVaultKeys();
	// One item subscription feeds every vault's count and the tag list — the same shape as
	// desktop's sidebar (apps/desktop/src/routes/vault/route.tsx).
	const { items, isLoading: isLoadingItems } = useItems();
	const itemCounts = useItemCounts(isLoadingItems ? undefined : items);
	const createItemFlow = useCreateItemFlow(vaultKeys);

	const vaultGroups = [
		["personal", vaultKeys.filter((vault) => vault.vaultType === "personal")],
		["team", vaultKeys.filter((vault) => vault.vaultType === "team")],
	] as const;

	const tagRows = useMemo<TagRow[]>(() => {
		const counts = new Map<string, number>();
		for (const item of items) {
			for (const tag of item.tags ?? []) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries())
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [items]);

	return (
		<TabScreen
			title={m.mob_browse_title()}
			aurora
			actions={
				<>
					{/* Vault creation lives in the bar, not the FAB: the FAB is "new item" on
					    every tab, and a FAB that means two different things depending on a
					    segmented control is the kind of thing you have to read twice. */}
					{segment === "vaults" ? (
						<BarButton
							onClick={() => setIsCreateVaultOpen(true)}
							aria-label={m.mob_vault_action_new()}
						>
							<IconPlus className={iconClass.bar} />
						</BarButton>
					) : null}
				</>
			}
			toolbar={
				<Segmented
					ariaLabel={m.mob_browse_title()}
					value={segment}
					onChange={setSegment}
					options={[
						{ key: "vaults", label: m.mob_tab_vaults() },
						{ key: "tags", label: m.mob_tab_tags() },
					]}
				/>
			}
			overlay={
				<Fab
					onPress={() => createItemFlow.setIsOpen(true)}
					ariaLabel={m.mob_create_item_header()}
				/>
			}
		>
			{segment === "vaults" ? (
				isLoadingVaults ? (
					<ItemsSkeleton count={4} />
				) : vaultKeys.length === 0 ? (
					<EmptyState
						className="min-h-full"
						icon={IconVault}
						title={m.mob_vaults_empty_title()}
						description={m.mob_vaults_empty_description()}
						action={{
							label: m.mob_vault_action_new(),
							onPress: () => setIsCreateVaultOpen(true),
						}}
					/>
				) : (
					<div className="flex flex-col gap-6 px-4 pt-4">
						{vaultGroups.map(([kind, group]) =>
							group.length === 0 ? null : (
								<section key={kind}>
									<SectionLabel
										trailing={
											<span className="font-semibold text-2xs text-muted-foreground">
												{group.length}
											</span>
										}
									>
										{kind === "personal"
											? m.mob_vaults_section_personal()
											: m.mob_vaults_section_team()}
									</SectionLabel>
									<ListCard>
										{group.map((vault) => {
											const count = itemCounts?.byVault[vault.vaultId] ?? 0;
											return (
												<ListRow
													key={vault.vaultId}
													leading={
														<VaultTile
															name={vault.vaultName}
															icon={vault.vaultIcon}
															imageUrl={vault.vaultImageUrl}
															type={vault.vaultType}
														/>
													}
													title={vault.vaultName}
													subtitle={
														count === 1
															? m.mob_item_count_singular({
																	count: String(count),
																})
															: m.mob_item_count_plural({
																	count: String(count),
																})
													}
													showChevron
													onPress={() =>
														navigate({
															to: "/vault/$id",
															params: { id: vault.vaultId },
														})
													}
												/>
											);
										})}
									</ListCard>
								</section>
							),
						)}
					</div>
				)
			) : isLoadingItems ? (
				<ItemsSkeleton count={5} />
			) : tagRows.length === 0 ? (
				<EmptyState
					className="min-h-full"
					icon={IconTag}
					title={m.mob_tags_empty_no_tags()}
					description={m.mob_tags_empty_no_tags_description()}
				/>
			) : (
				<div className="px-4 pt-4">
					<TagListCard
						tags={tagRows}
						onSelect={(name) =>
							navigate({
								to: "/vault/tag/$tagName",
								params: { tagName: encodeURIComponent(name) },
							})
						}
					/>
				</div>
			)}

			<CreateItemSheet
				open={createItemFlow.isOpen}
				onOpenChange={createItemFlow.setIsOpen}
				vaults={createItemFlow.vaultOptions}
				onCreateItem={createItemFlow.handleCreateItem}
			/>

			<CreateVaultSheet
				open={isCreateVaultOpen}
				onOpenChange={setIsCreateVaultOpen}
				onCreated={(vaultId) =>
					navigate({ to: "/vault/$id", params: { id: vaultId } })
				}
			/>
		</TabScreen>
	);
}
