/**
 * The one empty state. A soft glyph well, a title, a line of guidance and at most one
 * action — never a bare "No items" string floating in the middle of a screen.
 */

import { cn } from "@bittery/ui/lib/utils";
import type { ComponentType, ReactNode } from "react";
import { BrandButton } from "./brand-button";
import { iconClass } from "./theme";

export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
}: {
	icon?: ComponentType<{ className?: string }>;
	title: ReactNode;
	description?: ReactNode;
	action?: { label: ReactNode; onPress: () => void };
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center px-8 py-16 text-center",
				className,
			)}
		>
			{Icon ? (
				<div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-surface-tertiary text-muted-foreground">
					<Icon className={cn(iconClass.header, "size-7")} />
				</div>
			) : null}
			<h2 className="font-semibold text-foreground text-lg">{title}</h2>
			{description ? (
				<p className="mt-1.5 max-w-xs text-balance text-muted-foreground text-sm">
					{description}
				</p>
			) : null}
			{action ? (
				<BrandButton
					label={action.label}
					onClick={action.onPress}
					fullWidth={false}
					className="mt-6"
				/>
			) : null}
		</div>
	);
}
