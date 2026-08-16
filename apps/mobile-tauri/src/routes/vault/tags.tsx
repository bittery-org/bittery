/**
 * M3-C2 — "Tags" tab (D12). Every tag used by any item across every unlocked vault
 * (`useCrossVaultTags`, same hook desktop's sidebar uses), searchable, each row pushing
 * `/vault/tag/$tagName`.
 */

import { useCrossVaultTags } from "@bittery/core/hooks";
import { getTagColorFromName, Skeleton } from "@bittery/ui";
import {
	IconChevronRight,
	IconSearch,
	IconTag,
	IconX,
} from "@bittery/ui/icons";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { TabScreen } from "@/components/vault/tab-screen";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/tags")({
	component: TagsScreen,
});

function TagsSkeleton() {
	return (
		<div className="flex flex-col gap-1 p-2">
			{[0, 1, 2, 3].map((row) => (
				<Skeleton key={row} className="h-12 rounded-lg" />
			))}
		</div>
	);
}

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
		<TabScreen title={m.mob_tab_tags()} activeTab="tags">
			<div className="flex h-9 items-center gap-2 border-b px-3">
				<IconSearch className="size-3.5 shrink-0 text-muted-foreground" />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={m.mob_tags_search_placeholder()}
					className="h-full w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				/>
				{query ? (
					<button
						type="button"
						onClick={() => setQuery("")}
						aria-label={m.mob_search_clear()}
						className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-foreground/5"
					>
						<IconX className="size-3.5" />
					</button>
				) : null}
			</div>

			{isLoading ? (
				<TagsSkeleton />
			) : filteredTags.length === 0 ? (
				<div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
					<h2 className="font-semibold text-lg">
						{query ? m.mob_tags_empty_no_results() : m.mob_tags_empty_no_tags()}
					</h2>
					<p className="text-muted-foreground text-sm">
						{query
							? m.mob_tags_empty_no_results_description()
							: m.mob_tags_empty_no_tags_description()}
					</p>
				</div>
			) : (
				<div className="flex flex-col gap-1 p-2">
					{filteredTags.map((tag) => {
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
								className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left active:bg-foreground/5"
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
								<IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
							</button>
						);
					})}
				</div>
			)}
		</TabScreen>
	);
}
