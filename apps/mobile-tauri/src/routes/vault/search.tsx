/**
 * M3-C2 — "Search" tab (D12). A full-screen search rather than desktop's `SearchCombobox`
 * popover (`apps/desktop/src/components/vault/search-combobox.tsx`) — that component is
 * app-level (assembles `Command`/`CommandInput` as an anchored dropdown sized for a desktop
 * header, and calls desktop's own `useNavigate`), so this is a small mobile-only screen built on
 * the same data hook, `useVaultSearch`, rather than a forced import. Custom header (a search
 * input, not a static title) instead of `TabScreen`'s generic one, same bounded-scroll-plus-tab-
 * bar shape.
 */

import { useVaultSearch } from "@bittery/core/hooks";
import { getDomainFromUrl } from "@bittery/shared/favicon";
import { getTagColorFromName, VaultAvatar } from "@bittery/ui";
import { IconSearch, IconTag, IconX } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { BottomTabBar } from "@/components/vault/bottom-tab-bar";
import { Favicon } from "@/components/vault/favicon";
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
		<div
			className="flex w-full flex-col overflow-hidden"
			style={{
				height: "calc(100dvh - var(--safe-top) - var(--safe-bottom))",
			}}
		>
			<header className="sticky top-0 z-10 flex min-h-14 shrink-0 items-center gap-2 border-b bg-background px-3">
				<IconSearch className="size-4 shrink-0 text-muted-foreground" />
				{/* No `autoFocus`: biome's `noAutofocus` flags it, and on Android it would pop the
				    keyboard immediately under every tab switch to this screen, covering half the
				    result list before the user has typed anything. A tap-to-focus field costs one
				    tap and does not fight the keyboard for layout space. */}
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={m.mob_search_placeholder()}
					className="h-11 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground"
				/>
				{query ? (
					<button
						type="button"
						onClick={() => setQuery("")}
						aria-label={m.mob_search_clear()}
						className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-foreground/5"
					>
						<IconX className="size-4" />
					</button>
				) : null}
			</header>

			<div
				className="flex-1 overflow-y-auto"
				style={{ overscrollBehavior: "contain" }}
			>
				{!hasQuery ? (
					<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
						<h2 className="font-semibold text-lg">
							{m.mob_search_empty_title()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.mob_search_empty_description()}
						</p>
					</div>
				) : !hasResults ? (
					<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
						<h2 className="font-semibold text-lg">
							{m.mob_search_no_results()}
						</h2>
						<p className="text-muted-foreground text-sm">
							{m.mob_search_no_results_description()}
						</p>
					</div>
				) : (
					<div className="flex flex-col gap-4 p-3">
						{results.items.length > 0 && (
							<section>
								<h3 className="mb-1 px-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
									{m.vaults_detail_tab_items()}
								</h3>
								<div className="flex flex-col gap-1">
									{results.items.map((item) => {
										const domain = item.url
											? getDomainFromUrl(item.url)
											: undefined;
										return (
											<button
												key={item.id}
												type="button"
												onClick={() =>
													navigate({
														to: "/vault/all-items/$itemId",
														params: { itemId: item.id },
													})
												}
												className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-foreground/5"
											>
												<Favicon
													item={{ url: item.url, category: item.category }}
													title={item.title}
													cardBrand={item.cardBrand}
													size="sm"
												/>
												<div className="min-w-0 flex-1">
													<p className="truncate font-medium text-sm">
														{item.title}
													</p>
													{(item.username || domain) && (
														<p className="truncate text-muted-foreground text-xs">
															{[item.username, domain]
																.filter(Boolean)
																.join(" · ")}
														</p>
													)}
												</div>
											</button>
										);
									})}
								</div>
							</section>
						)}

						{results.vaults.length > 0 && (
							<section>
								<h3 className="mb-1 px-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
									{m.nav_item_vaults()}
								</h3>
								<div className="flex flex-col gap-1">
									{results.vaults.map((vault) => (
										<button
											key={vault.id}
											type="button"
											onClick={() =>
												navigate({ to: "/vault/$id", params: { id: vault.id } })
											}
											className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-foreground/5"
										>
											<VaultAvatar
												name={vault.name}
												icon={vault.icon}
												imageUrl={vault.imageUrl}
												size="sm"
											/>
											<span className="min-w-0 flex-1 truncate font-medium text-sm">
												{vault.name}
											</span>
										</button>
									))}
								</div>
							</section>
						)}

						{results.tags.length > 0 && (
							<section>
								<h3 className="mb-1 px-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
									{m.vaults_detail_items_detail_tags_label()}
								</h3>
								<div className="flex flex-col gap-1">
									{results.tags.map((tag) => {
										const color = getTagColorFromName(tag);
										return (
											<button
												key={tag}
												type="button"
												onClick={() =>
													navigate({
														to: "/vault/tag/$tagName",
														params: { tagName: encodeURIComponent(tag) },
													})
												}
												className="flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-foreground/5"
											>
												<span
													className="flex size-9 shrink-0 items-center justify-center rounded-md"
													style={{ backgroundColor: `${color}20`, color }}
												>
													<IconTag className="size-4" />
												</span>
												<span className="min-w-0 flex-1 truncate font-medium text-sm">
													{tag}
												</span>
											</button>
										);
									})}
								</div>
							</section>
						)}
					</div>
				)}
			</div>

			<BottomTabBar active="search" />
		</div>
	);
}
