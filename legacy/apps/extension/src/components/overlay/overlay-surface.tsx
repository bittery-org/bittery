/**
 * Design primitives for Bittery's *in-page* surfaces — the autofill dropdown,
 * the passkey picker/save sheets and the save prompt.
 *
 * These render inside transparent extension iframes injected into arbitrary
 * websites, so unlike the popup they cannot rely on a page background existing
 * behind them. Every surface here is therefore a self-contained floating card
 * following the DESIGN.md recipe: `bg-popover rounded-lg border`, neutral
 * hovers, purple reserved for selection and a single header hairline.
 *
 * The drop shadow is the one deviation: it is drawn by the *host element* in
 * the content script rather than here, because a shadow painted inside the
 * iframe is clipped at the frame's edge. See `content-script/overlay-chrome.ts`.
 */

import { cn } from "@bittery/ui";
import type { ReactNode } from "react";

/**
 * Root of an overlay document.
 *
 * Deliberately unpadded: the iframe is sized exactly to the card and the drop
 * shadow is drawn by the host element outside it (see `content-script/
 * overlay-chrome.ts`). Padding here would reintroduce a transparent band that
 * clips the shadow and swallows clicks meant for the page underneath.
 */
export function OverlayViewport({
	children,
	className,
}: {
	children?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("w-full text-foreground", className)}>{children}</div>
	);
}

/** The floating card itself. */
export function OverlaySurface({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"relative overflow-hidden rounded-lg border bg-popover text-popover-foreground",
				className,
			)}
		>
			{children}
		</div>
	);
}

/**
 * The brand moment for overlays, reduced to a single purple hairline along the
 * top edge.
 *
 * This started as the dialog-header treatment — hairline *plus* a 64px
 * `primary-deep` wash — but at overlay scale the wash covers most of the card
 * and reads as an ambient purple tint rather than an accent, which is exactly
 * what DESIGN.md warns against. The hairline alone keeps the cue.
 */
export function OverlayBrandAccent() {
	return (
		<span
			aria-hidden
			className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-primary/40 to-transparent"
		/>
	);
}

/** Small purple gradient tile used for the leading glyph of a prompt header. */
export function OverlayBrandTile({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-md bg-linear-to-b from-primary to-primary-deep text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12),0_0_12px_color-mix(in_oklab,var(--color-primary)_45%,transparent)]",
				className,
			)}
		>
			{children}
		</span>
	);
}

/**
 * Compact header for list overlays: an uppercase section label on the left and
 * an optional count chip on the right.
 */
export function OverlayListHeader({
	label,
	meta,
}: {
	label: string;
	meta?: ReactNode;
}) {
	return (
		<div className="relative flex items-center gap-2 px-2.5 pt-2 pb-1.5">
			<OverlayBrandAccent />
			<span className="relative font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
				{label}
			</span>
			{meta && (
				<span className="relative ml-auto text-[10.5px] text-muted-foreground">
					{meta}
				</span>
			)}
		</div>
	);
}

/** Header for prompt-style overlays: brand tile, title and subtitle. */
export function OverlayPromptHeader({
	icon,
	leading,
	title,
	subtitle,
	meta,
}: {
	/** Glyph shown inside the purple brand tile. Ignored when `leading` is set. */
	icon?: ReactNode;
	/** Replaces the brand tile entirely (e.g. the site's favicon). */
	leading?: ReactNode;
	title: ReactNode;
	subtitle?: ReactNode;
	meta?: ReactNode;
}) {
	return (
		<div className="relative flex items-start gap-2.5 px-3 pt-3 pb-2.5">
			<OverlayBrandAccent />
			{leading ?? (
				<OverlayBrandTile className="relative">{icon}</OverlayBrandTile>
			)}
			<div className="relative min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<p className="min-w-0 flex-1 truncate font-medium text-sm">{title}</p>
					{meta && <span className="shrink-0">{meta}</span>}
				</div>
				{subtitle && (
					<p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
						{subtitle}
					</p>
				)}
			</div>
		</div>
	);
}

/** Scroll container for overlay lists. */
export function OverlayList({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				// `p-1.5` rather than `p-1` so the selected row's indicator bar (which
				// sits at `-4px`) clears the card's border instead of touching it.
				"bittery-overlay-scroll max-h-[248px] overflow-y-auto p-1.5",
				className,
			)}
		>
			{children}
		</div>
	);
}

/**
 * A selectable row. Follows the DESIGN.md selection recipe exactly — tinted
 * surface plus inset hairline plus a glowing indicator bar, never a solid fill.
 */
export function OverlayRow({
	selected,
	leading,
	title,
	subtitle,
	details,
	trailing,
	onSelect,
	onHover,
	rowRef,
	ariaPressed,
}: {
	selected: boolean;
	leading?: ReactNode;
	title: ReactNode;
	subtitle?: ReactNode;
	/** Extra content below the subtitle (chips, badges) — not truncated. */
	details?: ReactNode;
	trailing?: ReactNode;
	onSelect: () => void;
	onHover?: () => void;
	rowRef?: (element: HTMLButtonElement | null) => void;
	ariaPressed?: boolean;
}) {
	return (
		<button
			ref={rowRef}
			type="button"
			aria-pressed={ariaPressed}
			onClick={onSelect}
			onMouseEnter={onHover}
			className={cn(
				"relative flex min-h-10 w-full gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors",
				details ? "items-start" : "items-center",
				"focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
				selected
					? "bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
					: "hover:bg-overlay",
			)}
		>
			{selected && (
				<span
					aria-hidden
					className="absolute top-[7px] bottom-[7px] left-[-4px] w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
				/>
			)}
			{leading}
			<span className="min-w-0 flex-1">
				<span className="block truncate font-medium text-[12.5px] text-foreground">
					{title}
				</span>
				{subtitle && (
					<span className="mt-px block truncate text-[11px] text-muted-foreground">
						{subtitle}
					</span>
				)}
				{details && (
					<span className="mt-1.5 flex flex-wrap items-center gap-1">
						{details}
					</span>
				)}
			</span>
			{trailing}
		</button>
	);
}

/** Neutral chip used for counts, vault names and other row metadata. */
export function OverlayChip({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground",
				className,
			)}
		>
			{children}
		</span>
	);
}

/** Keyboard key chip. */
export function OverlayKbd({ children }: { children: ReactNode }) {
	return (
		<kbd className="rounded-[4px] border bg-foreground/3 px-1 py-px font-sans text-[10px] text-muted-foreground leading-[14px]">
			{children}
		</kbd>
	);
}

/** Hairline footer strip, used for keyboard hints. */
export function OverlayFooter({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center justify-center gap-1.5 border-t px-2.5 py-1.5 text-[10px] text-muted-foreground">
			{children}
		</div>
	);
}

/**
 * Message state: empty results, locked vault, re-auth required. `tone` only
 * colours the glyph — the surface itself stays neutral.
 */
export function OverlayNotice({
	icon,
	title,
	description,
	tone = "muted",
	action,
}: {
	icon: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	tone?: "muted" | "primary" | "warning" | "success" | "destructive";
	action?: ReactNode;
}) {
	return (
		<div className="relative px-3 py-2.5">
			{tone === "primary" && <OverlayBrandAccent />}
			<div className="relative flex items-start gap-2.5">
				<span
					className={cn(
						"flex size-6 shrink-0 items-center justify-center rounded-md border bg-foreground/3",
						tone === "primary" &&
							"border-primary/25 bg-primary/10 text-primary",
						tone === "warning" &&
							"border-warning/30 bg-warning/10 text-warning",
						tone === "success" &&
							"border-success/30 bg-success/10 text-success",
						tone === "destructive" &&
							"border-destructive/30 bg-destructive/10 text-destructive",
						tone === "muted" && "text-muted-foreground",
					)}
				>
					{icon}
				</span>
				<div className="min-w-0 flex-1">
					<p className="font-medium text-[12.5px]">{title}</p>
					{description && (
						<p className="mt-0.5 text-[11px] text-muted-foreground">
							{description}
						</p>
					)}
					{action && <div className="mt-2">{action}</div>}
				</div>
			</div>
		</div>
	);
}

/** Action bar pinned to the bottom of prompt overlays. */
export function OverlayActions({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center gap-2 border-t px-3 py-2.5">
			{children}
		</div>
	);
}
