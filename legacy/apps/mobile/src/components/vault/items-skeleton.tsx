/**
 * The placeholder every item and vault list shows while its rows decrypt. Ported from
 * `apps/mobile/src/components/items-skeleton-list.tsx`.
 *
 * One component for both kinds of list because they have the same geometry: a 40pt leading tile
 * and a two-line label at `layout.rowHeight`. A skeleton that does not match the row it stands in
 * for makes the list jump when the data lands, which is the one thing a skeleton exists to stop.
 */

import { Skeleton } from "@bittery/ui";
import { cn } from "@bittery/ui/lib/utils";
import { Fragment } from "react";
import { layout } from "@/components/ui";

export function ItemsSkeleton({
	count = 6,
	className,
}: {
	count?: number;
	className?: string;
}) {
	const rows = Array.from({ length: count }, (_, index) => `row-${index}`);

	return (
		<div className={cn("px-4 pt-4", className)}>
			<div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-surface">
				{rows.map((row, index) => (
					<Fragment key={row}>
						{index > 0 ? <div className="ml-4 h-px bg-separator" /> : null}
						<div
							className="flex items-center gap-3 px-4"
							style={{ minHeight: layout.rowHeight }}
						>
							<Skeleton className="size-10 shrink-0 rounded-xl" />
							<div className="flex flex-1 flex-col gap-2">
								<Skeleton className="h-3.5 w-32 rounded-full" />
								<Skeleton className="h-3 w-20 rounded-full" />
							</div>
						</div>
					</Fragment>
				))}
			</div>
		</div>
	);
}
