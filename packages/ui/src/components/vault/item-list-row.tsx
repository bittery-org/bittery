import type * as React from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";
import { activeRailTarget } from "../active-rail";
import { Checkbox } from "../checkbox";

interface VaultItemListRowProps extends React.HTMLAttributes<HTMLDivElement> {
	itemTitle: string;
	ariaLabel: string;
	leadingVisual: React.ReactNode;
	indicators?: React.ReactNode;
	secondaryText?: string;
	tertiaryText?: string;
	isSelected: boolean;
	selectionMode?: boolean;
	isChecked?: boolean;
	isAnyItemDragging?: boolean;
	isDragging?: boolean;
	onPrimaryAction: () => void;
	onToggleCheck?: () => void;
	/** Placed on the primary-action button, never the drag wrapper, so a row resolves to one element. */
	dataTestId?: string;
	dataItemId?: string;
}

export const VaultItemListRow = forwardRef<HTMLDivElement, VaultItemListRowProps>(
	function VaultItemListRow(
		{
			itemTitle,
			ariaLabel,
			leadingVisual,
			indicators,
			secondaryText,
			tertiaryText,
			isSelected,
			selectionMode = false,
			isChecked = false,
			isAnyItemDragging = false,
			isDragging = false,
			onPrimaryAction,
			onToggleCheck,
			dataTestId,
			dataItemId,
			className,
			...props
		},
		ref,
	) {
		return (
			<div
				ref={ref}
				{...activeRailTarget(isSelected)}
				className={cn(
					"relative flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors",
					// Selection is the list's `ActiveRail` plus the absence of hover —
					// the row itself stays untinted, so hover never outweighs it.
					isSelected
						? ""
						: isChecked
							? "border border-primary/30 bg-selected"
							: isAnyItemDragging
								? "hover:bg-foreground/4 opacity-60"
								: "hover:bg-foreground/4",
					isDragging && "opacity-40",
					className,
				)}
				{...props}
			>

				{selectionMode && (
					<div className="relative z-10">
						<Checkbox
							checked={isChecked}
							onCheckedChange={() => onToggleCheck?.()}
							onClick={(e) => e.stopPropagation()}
						/>
					</div>
				)}

				<button
					type="button"
					onClick={() => (selectionMode ? onToggleCheck?.() : onPrimaryAction())}
					className="absolute inset-0 z-0 cursor-pointer rounded-md"
					aria-label={ariaLabel}
					data-testid={dataTestId}
					data-item-id={dataItemId}
					data-item-title={itemTitle}
				/>

				<div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-2.5">
					{leadingVisual}
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<span className="truncate font-medium text-foreground text-sm">
								{itemTitle}
							</span>
							{indicators}
						</div>
						{secondaryText && (
							<div
								className={cn(
									"mt-0.5 truncate text-xs",
									isSelected ? "text-foreground/70" : "text-muted-foreground",
								)}
							>
								{secondaryText}
							</div>
						)}
						{tertiaryText && (
							<div
								className={cn(
									"mt-0.5 truncate text-xs",
									isSelected ? "text-foreground/70" : "text-muted-foreground",
								)}
							>
								{tertiaryText}
							</div>
						)}
					</div>
				</div>
			</div>
		);
	},
);