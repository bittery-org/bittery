/**
 * iOS-style segmented control: a recessed track with a single raised thumb that slides.
 *
 * The thumb is one absolutely-positioned element translated by index rather than a
 * background on the active segment — that is the whole reason the control feels native, and
 * it is why segments must be equal width.
 */

import { cn } from "@bittery/ui/lib/utils";
import type { ReactNode } from "react";
import { Pressable } from "./pressable";

export interface SegmentOption<Key extends string> {
	key: Key;
	label: ReactNode;
}

export function Segmented<Key extends string>({
	options,
	value,
	onChange,
	ariaLabel,
	className,
}: {
	options: ReadonlyArray<SegmentOption<Key>>;
	value: Key;
	onChange: (key: Key) => void;
	ariaLabel: string;
	className?: string;
}) {
	const activeIndex = Math.max(
		0,
		options.findIndex((option) => option.key === value),
	);

	return (
		<div
			role="tablist"
			aria-label={ariaLabel}
			className={cn(
				"relative flex h-9 w-full items-stretch rounded-xl bg-surface-tertiary p-0.5",
				className,
			)}
		>
			<span
				aria-hidden
				className="absolute inset-y-0.5 left-0.5 rounded-[10px] bg-surface shadow-surface transition-transform duration-200 ease-native"
				style={{
					width: `calc((100% - 4px) / ${options.length})`,
					transform: `translateX(${activeIndex * 100}%)`,
				}}
			/>
			{options.map((option) => {
				const isActive = option.key === value;
				return (
					<button
						key={option.key}
						type="button"
						role="tab"
						aria-selected={isActive}
						onClick={() => onChange(option.key)}
						className={cn(
							"relative z-10 flex-1 touch-manipulation select-none truncate rounded-[10px] px-3 text-sm outline-none transition-colors duration-150",
							isActive
								? "font-semibold text-foreground"
								: "font-medium text-muted-foreground",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

/**
 * The horizontal-scrolling sibling of `Segmented`, for one-of-N choices that will not fit as
 * equal-width segments — link expiry, filter facets. Ported from `apps/mobile`'s `ChipRail`.
 *
 * It bleeds past the screen's 16px gutter on purpose: a rail that stops at the gutter reads as
 * a finished row, and the user never discovers the chips off-screen. The padding moves onto the
 * scroller so the first and last chip still line up with everything else.
 */
export function ChipRail<Key extends string>({
	chips,
	value,
	onChange,
	ariaLabel,
	className,
}: {
	chips: ReadonlyArray<SegmentOption<Key>>;
	value: Key;
	onChange: (key: Key) => void;
	ariaLabel: string;
	className?: string;
}) {
	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			className={cn(
				"native-scroll -mx-4 flex gap-2 overflow-x-auto px-4",
				className,
			)}
		>
			{chips.map((chip) => {
				const isActive = chip.key === value;
				return (
					<Pressable
						key={chip.key}
						role="radio"
						aria-checked={isActive}
						surface="sheet"
						onClick={() => onChange(chip.key)}
						className={cn(
							"flex h-9 shrink-0 items-center rounded-lg px-3.5 font-medium text-sm transition-colors",
							isActive
								? "bg-primary text-primary-foreground"
								: "bg-surface-tertiary text-muted-foreground",
						)}
					>
						{chip.label}
					</Pressable>
				);
			})}
		</div>
	);
}
