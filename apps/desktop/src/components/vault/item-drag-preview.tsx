import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { Favicon } from "./favicon";

interface ItemDragPreviewProps {
	item: DecryptedItemWithContext;
}

export function ItemDragPreview({ item }: ItemDragPreviewProps) {
	return (
		<div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 shadow-pop">
			<Favicon item={item} size="sm" />
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
