/**
 * The canvas and the app bar — the two things every route composes.
 *
 * Height: `__root.tsx` is a full-WebView flex column that pads `--safe-top` only, so
 * `Screen` is `flex-1` and fills whatever is left. Do not size this with `100dvh` minus
 * insets — on Android WebView `dvh` and the WebView bounds disagree (especially on
 * Samsung 3-button nav), and subtracting `--safe-bottom` here while `TabBar` also pads
 * it leaves a blank band above the system buttons.
 */

import { IconArrowLeft } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";
import { Aurora } from "./brand";
import { BarButton } from "./pressable";
import { iconClass, scrollBottomInset } from "./theme";

interface ScreenProps {
	children: ReactNode;
	/** Paints the sanctioned top wash. Items, Browse, auth and unlock only. */
	aurora?: boolean;
	/** Sheets and modal-ish routes sit on the popover rung instead of the canvas. */
	surface?: "background" | "overlay";
	className?: string;
}

export function Screen({
	children,
	aurora = false,
	surface = "background",
	className,
}: ScreenProps) {
	return (
		<div
			className={cn(
				"relative flex min-h-0 w-full flex-1 flex-col overflow-hidden",
				surface === "overlay" ? "bg-surface-secondary" : "bg-background",
				className,
			)}
		>
			{aurora ? <Aurora /> : null}
			{children}
		</div>
	);
}

interface AppBarProps {
	/** Compact title: sits in a 52px row, centred weight, for pushed screens. */
	title?: ReactNode;
	/**
	 * The screen's large title. It shares its row with `leading` and `actions` rather than
	 * stacking below them — a phone has no vertical space for a band that holds an avatar.
	 */
	largeTitle?: ReactNode;
	subtitle?: ReactNode;
	leading?: ReactNode;
	actions?: ReactNode;
	onBack?: () => void;
	backLabel?: string;
	/**
	 * Hairline + blur under the bar. Turn it on for screens whose content scrolls beneath;
	 * `AppBar` is translucent so the content visibly passes under it, which is the single
	 * biggest "this is native" cue a WebView can give.
	 */
	bordered?: boolean;
	className?: string;
}

export function AppBar({
	title,
	largeTitle,
	subtitle,
	leading,
	actions,
	onBack,
	backLabel,
	bordered = true,
	className,
}: AppBarProps) {
	const isLarge = Boolean(largeTitle) && !title;

	return (
		<header
			className={cn(
				"relative z-20 shrink-0",
				// `supports-[backdrop-filter]` guards the one WebView build that lacks it:
				// there the bar falls back to an opaque surface rather than to transparency.
				"bg-background/80 supports-[backdrop-filter]:backdrop-blur-xl",
				bordered && "border-border/80 border-b",
				className,
			)}
		>
			<div
				className={cn(
					"flex items-center gap-2 px-2",
					isLarge ? "min-h-14 py-2 pr-2 pl-3" : "h-[var(--app-bar-height)]",
				)}
			>
				{onBack ? (
					<BarButton onClick={onBack} aria-label={backLabel} className="-ml-1">
						<IconArrowLeft className={iconClass.bar} />
					</BarButton>
				) : null}
				{leading}
				{isLarge || title ? (
					<div className={cn("min-w-0 flex-1", !onBack && !leading && "pl-2")}>
						<h1
							className={cn(
								"truncate font-semibold text-foreground",
								isLarge ? "text-2xl tracking-tight" : "text-lg",
							)}
						>
							{largeTitle ?? title}
						</h1>
						{subtitle ? (
							<p className="truncate text-muted-foreground text-sm">
								{subtitle}
							</p>
						) : null}
					</div>
				) : (
					<div className="flex-1" />
				)}
				{actions ? (
					<div className="flex shrink-0 items-center gap-0.5">{actions}</div>
				) : null}
			</div>
		</header>
	);
}

/**
 * The bounded, momentum-scrolling content region. `inset` reserves room at the bottom so
 * the last row clears the tab bar and the home indicator — native's `useBottomInset()`.
 */
export function ScreenScroll({
	children,
	inset = "plain",
	className,
	style,
}: {
	children: ReactNode;
	inset?: keyof typeof scrollBottomInset;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<div
			className={cn("native-scroll relative z-10 min-h-0 flex-1", className)}
			style={{ paddingBottom: scrollBottomInset[inset], ...style }}
		>
			{children}
		</div>
	);
}
