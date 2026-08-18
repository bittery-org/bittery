/**
 * The bottom sheet every mobile menu, picker and confirm uses.
 *
 * It wraps `@bittery/ui`'s Radix-backed `Sheet` for the parts that are genuinely hard —
 * focus trap, scroll lock, escape, `aria-modal` — and replaces the desktop chrome: a
 * grabber instead of a corner ✕, a 20px top radius, the sanctioned brand wash, and safe-area
 * padding so the last action clears the home indicator.
 *
 * `[&>button]:hidden` removes `SheetContent`'s built-in close ✕. It is a direct child of the
 * content element and the only direct-child `<button>` — everything this component renders
 * is wrapped in a `<div>` precisely so that stays true. `@bittery/ui` does not export the
 * raw Radix content primitive, and `radix-ui` is not resolvable from this app, so styling it
 * out is the contained option; the alternative is a second copy of the whole sheet.
 */

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@bittery/ui";
import { cn } from "@bittery/ui/lib/utils";
import type { ComponentType, ReactNode } from "react";
import { Pressable } from "./pressable";

export function MobileSheet({
	open,
	onOpenChange,
	title,
	description,
	/** Hides the title visually but keeps it for screen readers. */
	hideTitle = false,
	brandAccent = true,
	children,
	className,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	hideTitle?: boolean;
	brandAccent?: boolean;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="bottom"
				className={cn(
					"flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-t-[20px] border-t-0 bg-surface-secondary p-0",
					"shadow-overlay outline-none [&>button]:hidden",
					// Radix animates with its own duration; the easing is ours.
					"data-[state=closed]:duration-200 data-[state=open]:duration-300",
					className,
				)}
				style={{ paddingBottom: "var(--safe-bottom)" }}
			>
				<div className="relative flex min-h-0 flex-col">
					{brandAccent ? <SheetBrandWash /> : null}

					{/* Grabber. Decorative: the sheet is dismissed by the scrim or a button. */}
					<div className="relative z-10 flex shrink-0 justify-center pt-2.5 pb-1">
						<span
							aria-hidden
							className="h-1 w-9 rounded-full bg-foreground/20"
						/>
					</div>

					<div
						className={cn(
							"relative z-10 shrink-0 px-4 pt-2 pb-4 text-center",
							hideTitle && "sr-only",
						)}
					>
						<SheetTitle className="font-semibold text-foreground text-lg">
							{title}
						</SheetTitle>
						{description ? (
							<SheetDescription className="mt-1 text-muted-foreground text-sm">
								{description}
							</SheetDescription>
						) : (
							<SheetDescription className="sr-only">{title}</SheetDescription>
						)}
					</div>

					<div className="native-scroll relative z-10 min-h-0 flex-1">
						{children}
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

/**
 * Inlined rather than imported from `brand.tsx` so the sheet's wash can start below the
 * rounded corner without a second wrapper.
 */
function SheetBrandWash() {
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-x-0 top-0 z-0 h-24"
		>
			<div
				className="absolute inset-0"
				style={{
					background:
						"linear-gradient(to bottom, color-mix(in oklab, var(--primary-deep) 20%, transparent), transparent)",
				}}
			/>
			<div
				className="absolute inset-x-0 top-0 h-px"
				style={{
					background:
						"linear-gradient(to right, transparent, color-mix(in oklab, var(--primary-deep) 55%, transparent), transparent)",
				}}
			/>
		</div>
	);
}

/**
 * One of the verb rows a sheet offers below its list: glyph well, label, nothing else.
 * Uses the `sheet` press surface, which tints one rung above the sheet's own background.
 */
export function SheetAction({
	label,
	icon: Icon,
	onPress,
	tone = "default",
	disabled,
}: {
	label: ReactNode;
	icon: ComponentType<{ className?: string }>;
	onPress: () => void;
	tone?: "default" | "danger";
	disabled?: boolean;
}) {
	const isDanger = tone === "danger";

	return (
		<PressableRow onPress={onPress} disabled={disabled}>
			<span
				className={cn(
					"flex size-10 shrink-0 items-center justify-center rounded-xl",
					isDanger
						? "bg-danger-soft text-danger"
						: "bg-surface-tertiary text-foreground",
				)}
			>
				<Icon className="size-5" />
			</span>
			<span
				className={cn(
					"truncate font-medium text-base",
					isDanger ? "text-danger" : "text-foreground",
				)}
			>
				{label}
			</span>
		</PressableRow>
	);
}

/**
 * The destructive-confirm action sheet — the phone answer to a desktop alert dialog. The
 * dangerous verb is the filled button and Cancel is the quiet one, so the safe choice is
 * still the easy one to hit.
 */
export function ConfirmSheet({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	cancelLabel,
	onConfirm,
	isPending = false,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	confirmLabel: string;
	cancelLabel: string;
	onConfirm: () => void;
	isPending?: boolean;
}) {
	return (
		<MobileSheet
			open={open}
			onOpenChange={onOpenChange}
			title={title}
			description={description}
			brandAccent={false}
		>
			<div className="flex flex-col gap-2 px-4 pt-1 pb-6">
				<Pressable
					onClick={onConfirm}
					disabled={isPending}
					scale
					haptic={false}
					className="flex h-12 w-full items-center justify-center rounded-xl bg-danger font-semibold text-base text-white"
				>
					{confirmLabel}
				</Pressable>
				<Pressable
					onClick={() => onOpenChange(false)}
					surface="sheet"
					className="flex h-12 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
				>
					{cancelLabel}
				</Pressable>
			</div>
		</MobileSheet>
	);
}

function PressableRow({
	children,
	onPress,
	disabled,
}: {
	children: ReactNode;
	onPress: () => void;
	disabled?: boolean;
}) {
	return (
		<Pressable
			onClick={onPress}
			disabled={disabled}
			surface="sheet"
			className="flex h-14 w-full items-center gap-3 rounded-xl px-2"
		>
			{children}
		</Pressable>
	);
}
