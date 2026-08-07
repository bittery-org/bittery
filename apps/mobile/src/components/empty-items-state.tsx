import { type AppIcon, EmptyState, IconKey } from "@/components/ui";

export interface EmptyItemsStateProps {
	title: string;
	description: string;
	icon?: AppIcon;
	actionLabel?: string;
	onAction?: () => void;
}

/** The kit's empty state with the item-list default glyph. */
export function EmptyItemsState({
	title,
	description,
	icon = IconKey,
	actionLabel,
	onAction,
}: EmptyItemsStateProps) {
	return (
		<EmptyState
			icon={icon}
			title={title}
			description={description}
			actionLabel={actionLabel}
			onAction={onAction}
		/>
	);
}
