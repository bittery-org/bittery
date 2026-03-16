import type * as React from "react";
import { forwardRef } from "react";
import { cn } from "../../lib/utils";
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
			className,
			...props
		},
		ref,
	) {
		return (
			<div
				ref={ref}
				className={cn(
					"relative flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 transition-colors",
					isSelected
						? "bg-primary text-primary-foreground"
						: isChecked
							? "border border-primary/30 bg-primary/5"
							: isAnyItemDragging
								? "hover:bg-primary/10 opacity-60"
								: "hover:bg-primary/10",
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
				/>

				<div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-3">
					{leadingVisual}
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5">
							<span className="truncate font-medium text-sm">{itemTitle}</span>
							{indicators}
						</div>
						{secondaryText && (
							<div
								className={cn(
									"mt-0.5 truncate text-xs",
									isSelected
										? "text-primary-foreground"
										: "text-muted-foreground",
								)}
							>
								{secondaryText}
							</div>
						)}
						{tertiaryText && (
							<div
								className={cn(
									"mt-0.5 truncate text-xs",
									isSelected
										? "text-primary-foreground"
										: "text-muted-foreground",
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