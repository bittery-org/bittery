/**
 * The full tag list, searchable. No longer a tab (DESIGN-NATIVE.md § Information architecture) —
 * it is pushed from Browse's Tags segment, so it is a `MobileScreen` with a back affordance.
 *
 */

import { useCrossVaultTags } from "@bittery/core/hooks";
import { IconSearch, IconTag, IconX } from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { MobileScreen } from "@/components/mobile-screen";
import { BarButton, EmptyState, iconClass } from "@/components/ui";
import { ItemsSkeleton } from "@/components/vault/items-skeleton";
import { TagListCard } from "@/components/vault/tag-list";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/tags")({
	component: TagsScreen,
});

function TagsScreen() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { tags, isLoading } = useCrossVaultTags();
	const [query, setQuery] = useState("");

	const filteredTags = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return tags;
		return tags.filter((tag) => tag.toLowerCase().includes(normalized));
	}, [tags, query]);

	return (
		<MobileScreen
			title={m.mob_tab_tags()}
			backLabel={m.mob_common_go_back()}
			onBack={() => navigate({ to: "/vault" })}
			toolbar={
				<div className="flex h-10 items-center gap-2 rounded-xl border border-border bg-surface px-3">
					<IconSearch className="size-4 shrink-0 text-muted-foreground" />
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={m.mob_tags_search_placeholder()}
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
			}
		>
			{isLoading ? (
				<ItemsSkeleton count={5} />
			) : filteredTags.length === 0 ? (
				<EmptyState
					className="min-h-full"
					icon={IconTag}
					title={
						query ? m.mob_tags_empty_no_results() : m.mob_tags_empty_no_tags()
					}
					description={
						query
							? m.mob_tags_empty_no_results_description()
							: m.mob_tags_empty_no_tags_description()
					}
				/>
			) : (
				<div className="px-4 pt-4">
					<TagListCard
						tags={filteredTags.map((name) => ({ name }))}
						onSelect={(name) =>
							navigate({
								to: "/vault/tag/$tagName",
								params: { tagName: encodeURIComponent(name) },
							})
						}
					/>
				</div>
			)}
		</MobileScreen>
	);
}
