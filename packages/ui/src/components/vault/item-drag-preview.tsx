import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { cn } from "../../lib/utils";
import { VaultFavicon } from "./favicon";

/**
 * Minimal shape the drag preview (and the favicon it renders) needs. Works
 * for both `DecryptedItem` (no account context) and `DecryptedItemWithContext`.
 */
export type ItemDragPreviewItem = Pick<
	DecryptedItemWithContext,
	"title" | "username" | "url" | "category" | "serverUrl" | "account"
>;

interface ItemDragPreviewProps<T extends ItemDragPreviewItem> {
	item: T;
	/** Fallback server URL for resolving the favicon, e.g. from the active auth session. */
	defaultServerUrl?: string;
	/**
	 * Overrides the floating-surface shadow. Defaults to the design system's
	 * `shadow-pop` token; pass a different class to match a platform that
	 * hasn't migrated to it yet.
	 */
	shadowClassName?: string;
}

export function ItemDragPreview<T extends ItemDragPreviewItem>({
	item,
	defaultServerUrl,
	shadowClassName = "shadow-pop",
}: ItemDragPreviewProps<T>) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-md border bg-background px-3 py-2",
				shadowClassName,
			)}
		>
			<VaultFavicon item={item} size="sm" defaultServerUrl={defaultServerUrl} />
			<div className="min-w-0 max-w-48">
				<div className="truncate font-medium text-sm">{item.title}</div>
				{item.username && (
					<div className="truncate text-muted-foreground text-xs">
						{item.username}
					</div>
				)}
			</div>
		</div>
	);
}
