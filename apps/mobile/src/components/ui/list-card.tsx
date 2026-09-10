/**
 * The grouped card that carries almost every list on mobile: one `surface` container,
 * hairline dividers between rows, no borders on the rows themselves. Ported from
 * `apps/mobile/src/components/ui/list-card.tsx`.
 */

import { IconChevronRight } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { GlowBar } from "./brand";
import { Pressable } from "./pressable";
import { iconClass, layout } from "./theme";

export function ListCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	const rows = Children.toArray(children).filter(isValidElement);

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border border-border bg-surface shadow-surface",
				className,
			)}
		>
			{rows.map((row, index) => (
				<Fragment key={row.key}>
					{/* Inset divider — it starts past the leading tile, as iOS does. */}
					{index > 0 ? <div className="ml-4 h-px bg-separator" /> : null}
					{row}
				</Fragment>
			))}
		</div>
	);
}

export interface ListRowProps {
	title: ReactNode;
	subtitle?: ReactNode;
	/** Right-aligned secondary text: a count, or the current value of a setting. */
	value?: ReactNode;
	leading?: ReactNode;
	trailing?: ReactNode;
	onPress?: () => void;
	isSelected?: boolean;
	isDisabled?: boolean;
	/** The chevron affordance for rows that push a screen. */
	showChevron?: boolean;
	tone?: "default" | "danger";
	compact?: boolean;
	/**
	 * Let the title and subtitle wrap. The default is a single-line ellipsis, which is
	 * right for settings values and item names, but clips the longer helper copy on
	 * auth banners.
	 */
	wrap?: boolean;
	ariaLabel?: string;
	className?: string;
}

export function ListRow({
	title,
	subtitle,
	value,
	leading,
	trailing,
	onPress,
	isSelected = false,
	isDisabled = false,
	showChevron = false,
	tone = "default",
	compact = false,
	wrap = false,
	ariaLabel,
	className,
}: ListRowProps) {
	const body = (
		<>
			{isSelected ? <GlowBar /> : null}
			{leading ? <div className="mr-3 shrink-0">{leading}</div> : null}
			<div className="min-w-0 flex-1 text-left">
				<div
					className={cn(
						"font-medium text-base",
						wrap ? "text-pretty" : "truncate",
						tone === "danger" ? "text-danger" : "text-foreground",
					)}
				>
					{title}
				</div>
				{subtitle ? (
					<div
						className={cn(
							"mt-0.5 text-muted-foreground text-sm",
							wrap ? "text-pretty" : "truncate",
						)}
					>
						{subtitle}
					</div>
				) : null}
			</div>
			{value ? (
				<div className="ml-3 shrink-0 truncate text-muted-foreground text-sm">
					{value}
				</div>
			) : null}
			{trailing ? <div className="ml-2 shrink-0">{trailing}</div> : null}
			{showChevron ? (
				<IconChevronRight
					className={cn(
						"ml-1 shrink-0 text-muted-foreground opacity-60",
						iconClass.row,
					)}
				/>
			) : null}
		</>
	);

	const rowClassName = cn(
		"flex w-full items-center px-4",
		wrap && "py-3",
		isSelected && "bg-selected",
		className,
	);
	const rowStyle = {
		minHeight: compact ? layout.rowHeightCompact : layout.rowHeight,
	};

	if (!onPress) {
		return (
			<div className={cn(rowClassName, "relative")} style={rowStyle}>
				{body}
			</div>
		);
	}

	return (
		<Pressable
			onClick={onPress}
			disabled={isDisabled}
			aria-label={ariaLabel}
			className={rowClassName}
			style={rowStyle}
		>
			{body}
		</Pressable>
	);
}

/** Uppercase group label that sits above a `ListCard`. */
export function SectionLabel({
	children,
	trailing,
	className,
}: {
	children: ReactNode;
	trailing?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn("flex items-center justify-between px-1 pb-2", className)}
		>
			<span className="font-semibold text-2xs text-muted-foreground uppercase tracking-[0.06em]">
				{children}
			</span>
			{trailing}
		</div>
	);
}

/**
 * Neutral tile behind a row glyph. The gradient tile is reserved for identity (accounts,
 * vaults, items) — a settings row gets this instead, so colour keeps meaning something.
 */
export function IconTile({
	children,
	tone = "default",
	className,
}: {
	children: ReactNode;
	tone?: "default" | "danger" | "brand";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex size-10 items-center justify-center rounded-xl",
				tone === "danger" && "bg-danger-soft text-danger",
				tone === "brand" && "bg-primary-soft text-primary",
				tone === "default" && "bg-surface-tertiary text-foreground",
				className,
			)}
		>
			{children}
		</div>
	);
}
