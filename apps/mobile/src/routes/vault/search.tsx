/**
 * Search — a pushed screen reached from the Items app bar, not a tab (DESIGN-NATIVE.md §
 * Information architecture). Desktop's `SearchCombobox` is an anchored dropdown sized for a
 * desktop header, so this is a small mobile-only screen over the same data hook, `useVaultSearch`.
 *
 * It composes `Screen` / `ScreenScroll` by hand rather than using `MobileScreen`, because the one
 * thing this screen needs is a focused field *where the title would be* — which is exactly what
 * `AppBar` does not do. Everything else (chrome, blur, insets) still comes from the kit.
 */

import { useVaultSearch } from "@bittery/core/hooks";
import { getDomainFromUrl } from "@bittery/shared/favicon";
import { IconArrowLeft, IconSearch, IconX } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	BarButton,
	EmptyState,
	iconClass,
	ListCard,
	ListRow,
	Screen,
	ScreenScroll,
	SectionLabel,
} from "@/components/ui";
import { Favicon } from "@/components/vault/favicon";
import { TagListCard } from "@/components/vault/tag-list";
import { VaultTile } from "@/components/vault/vault-tile";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/search")({
	component: SearchScreen,
});

function SearchScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const results = useVaultSearch(query);

	const hasQuery = query.trim().length > 0;
	const hasResults =
		results.items.length > 0 ||
		results.vaults.length > 0 ||
		results.tags.length > 0;

	return (
		<Screen>
			<header
				className="relative z-20 flex shrink-0 items-center gap-1 border-border/80 border-b bg-background/80 px-2 py-2 supports-[backdrop-filter]:backdrop-blur-xl"
				style={{ minHeight: "var(--app-bar-height)" }}
			>
				<BarButton
					onClick={() => navigate({ to: "/vault/all-items" })}
					aria-label={m.mob_common_go_back()}
					className="-ml-1"
				>
					<IconArrowLeft className={iconClass.bar} />
				</BarButton>

				<div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-surface px-3">
					<IconSearch className="size-4 shrink-0 text-muted-foreground" />
					{/* No `autoFocus`: biome's `noAutofocus` flags it, and on Android it would pop the
					    keyboard before the user has seen the screen, covering half the result list. */}
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={m.mob_search_placeholder()}
						className="h-full w-full min-w-0 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
					/>
					{query ? (
						<BarButton
							onClick={() => setQuery("")}
							aria-label={m.mob_search_clear()}
							className="-mr-2 size-8 text-muted-foreground"
						>
							<IconX className={iconClass.chip} />
						</BarButton>
					) : null}
				</div>
			</header>

			<ScreenScroll inset="plain">
				{!hasQuery ? (
					<EmptyState
						className="min-h-full"
						icon={IconSearch}
						title={m.mob_search_empty_title()}
						description={m.mob_search_empty_description()}
					/>
				) : !hasResults ? (
					<EmptyState
						className="min-h-full"
						icon={IconSearch}
						title={m.mob_search_no_results()}
						description={m.mob_search_no_results_description()}
					/>
				) : (
					<div className="flex flex-col gap-6 px-4 pt-4">
						{results.items.length > 0 ? (
							<section>
								<SectionLabel>{m.vaults_detail_tab_items()}</SectionLabel>
								<ListCard>
									{results.items.map((item) => {
										const domain = item.url
											? getDomainFromUrl(item.url)
											: undefined;
										const subtitle = [item.username, domain]
											.filter(Boolean)
											.join(" · ");

										return (
											<ListRow
												key={item.id}
												leading={
													<Favicon
														item={{ url: item.url, category: item.category }}
														title={item.title}
														cardBrand={item.cardBrand}
													/>
												}
												title={item.title}
												subtitle={subtitle || undefined}
												onPress={() =>
													navigate({
														to: "/vault/all-items/$itemId",
														params: { itemId: item.id },
													})
												}
											/>
										);
									})}
								</ListCard>
							</section>
						) : null}

						{results.vaults.length > 0 ? (
							<section>
								<SectionLabel>{m.nav_item_vaults()}</SectionLabel>
								<ListCard>
									{results.vaults.map((vault) => (
										<ListRow
											key={vault.id}
											leading={
												<VaultTile
													name={vault.name}
													icon={vault.icon}
													imageUrl={vault.imageUrl}
													type={vault.type}
												/>
											}
											title={vault.name}
											showChevron
											onPress={() =>
												navigate({ to: "/vault/$id", params: { id: vault.id } })
											}
										/>
									))}
								</ListCard>
							</section>
						) : null}

						{results.tags.length > 0 ? (
							<section>
								<SectionLabel>
									{m.vaults_detail_items_detail_tags_label()}
								</SectionLabel>
								<TagListCard
									tags={results.tags.map((name) => ({ name }))}
									onSelect={(name) =>
										navigate({
											to: "/vault/tag/$tagName",
											params: { tagName: encodeURIComponent(name) },
										})
									}
								/>
							</section>
						) : null}
					</div>
				)}
			</ScreenScroll>
		</Screen>
	);
}
