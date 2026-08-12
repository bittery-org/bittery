import type { DecryptedItemWithContext } from "@bittery/shared/types";
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
}

export function ItemDragPreview<T extends ItemDragPreviewItem>({
	item,
	defaultServerUrl,
}: ItemDragPreviewProps<T>) {
	return (
		<div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 shadow-pop">
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
