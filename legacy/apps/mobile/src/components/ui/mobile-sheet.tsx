/**
 * The bottom sheet every mobile menu, picker and confirm uses.
 *
 * A custom layer rather than `@bittery/ui`'s Radix `Sheet`: a WebView sheet only feels
 * native if the finger owns it — drag-to-dismiss, a scrim that tracks the drag, the
 * keyboard lifting the panel, Android back closing it. Radix gives us those for a
 * desktop drawer and fights us for everything else (a decorative grabber, a 60% black
 * fade, `pointer-events: none` on the body for the whole exit).
 *
 * The public props stay the same so every call site keeps working. Exit is still 220ms
 * (`SHEET_EXIT_MS`) so "close this sheet, then open the next" callers stay in sync.
 */

import { cn } from "@bittery/ui/lib/utils";
import {
	type ComponentType,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { presentSheet } from "@/lib/sheet-presence";
import {
	applyDragOffset,
	createGhostClickSuppress,
	DRAG_SLOP_PX,
	keyboardInset,
	SCRIM_OPACITY,
	SHEET_ENTER_MS,
	SHEET_EXIT_MS,
	SHEET_SNAP_MS,
	scrimOpacity,
	shouldDismiss,
	velocityFromSamples,
} from "./mobile-sheet-motion";
import { Pressable } from "./pressable";

export { SHEET_EXIT_MS };

type Phase = "enter" | "open" | "drag" | "snap" | "exit";

export function MobileSheet({
	open,
	onOpenChange,
	title,
	description,
	/** Hides the title visually but keeps it for screen readers. */
	hideTitle = false,
	// Parked: the purple top wash reads as leftover desktop chrome on a phone.
	// Flip this default (and DESIGN.md) if we restore it.
	brandAccent = false,
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
	const [mounted, setMounted] = useState(open);
	if (open && !mounted) setMounted(true);

	if (!mounted) return null;

	return createPortal(
		<SheetLayer
			open={open}
			onOpenChange={onOpenChange}
			onExited={() => setMounted(false)}
			title={title}
			description={description}
			hideTitle={hideTitle}
			brandAccent={brandAccent}
			className={className}
		>
			{children}
		</SheetLayer>,
		document.body,
	);
}

function SheetLayer({
	open,
	onOpenChange,
	onExited,
	title,
	description,
	hideTitle,
	brandAccent,
	className,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onExited: () => void;
	title: string;
	description?: string;
	hideTitle: boolean;
	brandAccent: boolean;
	className?: string;
	children: ReactNode;
}) {
	const titleId = useId();
	const descriptionId = useId();
	const scrimRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const onExitedRef = useRef(onExited);
	onExitedRef.current = onExited;

	const phaseRef = useRef<Phase>("enter");
	const offsetRef = useRef(0);
	const playExitRef = useRef<() => void>(() => undefined);
	const playEnterRef = useRef<() => void>(() => undefined);
	const releasePresenceRef = useRef<(() => void) | null>(null);
	const exitTimerRef = useRef<number | null>(null);
	const stopDragRef = useRef<(() => void) | null>(null);
	const ghostClickRef = useRef(createGhostClickSuppress());
	const layerRef = useRef<HTMLDivElement>(null);

	const close = () => onOpenChangeRef.current(false);

	const setExiting = (exiting: boolean) => {
		const layer = layerRef.current;
		if (layer) layer.toggleAttribute("data-exiting", exiting);
	};

	const claimPresence = () => {
		if (releasePresenceRef.current) return;
		releasePresenceRef.current = presentSheet(() =>
			onOpenChangeRef.current(false),
		);
	};

	const dropPresence = () => {
		releasePresenceRef.current?.();
		releasePresenceRef.current = null;
	};

	const applyFrame = (offset: number, progressOpacity: number) => {
		offsetRef.current = offset;
		paintFrame(panelRef.current, scrimRef.current, offset, progressOpacity);
	};

	const playEnter = () => {
		const panel = panelRef.current;
		if (!panel) return;
		if (exitTimerRef.current !== null) {
			window.clearTimeout(exitTimerRef.current);
			exitTimerRef.current = null;
		}
		phaseRef.current = "enter";
		setExiting(false);
		claimPresence();
		paintTransition(panel, scrimRef.current, SHEET_ENTER_MS);
		offsetRef.current = 0;
		paintFrame(panel, scrimRef.current, 0, SCRIM_OPACITY);
		panel.focus({ preventScroll: true });
		if (prefersReducedMotion()) {
			phaseRef.current = "open";
			return;
		}
		window.setTimeout(() => {
			if (phaseRef.current === "enter") phaseRef.current = "open";
		}, SHEET_ENTER_MS);
	};
	playEnterRef.current = playEnter;

	const playExit = () => {
		if (phaseRef.current === "exit") return;
		phaseRef.current = "exit";
		// Hand the page back now. Holding `inert` and a full-screen scrim for the
		// whole 220ms is why the next tap on the FAB / overflow had to be repeated.
		dropPresence();
		setExiting(true);
		panelRef.current?.removeAttribute("data-dragging");
		paintTransition(panelRef.current, scrimRef.current, SHEET_EXIT_MS);
		const panel = panelRef.current;
		if (panel) panel.style.transform = "translate3d(0, 100%, 0)";
		if (scrimRef.current) scrimRef.current.style.opacity = "0";
		exitTimerRef.current = window.setTimeout(() => {
			exitTimerRef.current = null;
			onExitedRef.current();
		}, SHEET_EXIT_MS);
	};
	playExitRef.current = playExit;

	const snapBack = () => {
		phaseRef.current = "snap";
		panelRef.current?.removeAttribute("data-dragging");
		paintTransition(panelRef.current, scrimRef.current, SHEET_SNAP_MS);
		applyFrame(0, SCRIM_OPACITY);
		window.setTimeout(() => {
			if (phaseRef.current === "snap") phaseRef.current = "open";
		}, SHEET_SNAP_MS);
	};

	/*
	 * Honest `useEffect`: this layer exists to push a React value into systems
	 * outside React — the document (`inert` on #root), Android's back button, the
	 * visual viewport, and focus. Same exception as `SystemBarsSync` in `__root.tsx`.
	 */
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;

		const previousFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;

		releasePresenceRef.current = presentSheet(() =>
			onOpenChangeRef.current(false),
		);

		const onGhostClick = (event: Event) => {
			if (!ghostClickRef.current.consume()) return;
			event.preventDefault();
			event.stopPropagation();
		};
		window.addEventListener("click", onGhostClick, true);

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onOpenChangeRef.current(false);
				return;
			}
			if (event.key !== "Tab") return;
			trapFocus(panel, event);
		};
		window.addEventListener("keydown", onKeyDown);

		const onViewport = () => liftForKeyboard(panel);
		const vv = window.visualViewport;
		vv?.addEventListener("resize", onViewport);
		vv?.addEventListener("scroll", onViewport);
		liftForKeyboard(panel);

		phaseRef.current = "enter";
		panel.style.transform = "translate3d(0, 100%, 0)";
		if (scrimRef.current) scrimRef.current.style.opacity = "0";
		panel.focus({ preventScroll: true });

		let cancelled = false;
		const start = () => {
			if (cancelled || phaseRef.current !== "enter") return;
			paintTransition(panel, scrimRef.current, SHEET_ENTER_MS);
			offsetRef.current = 0;
			paintFrame(panel, scrimRef.current, 0, SCRIM_OPACITY);
			if (prefersReducedMotion()) {
				phaseRef.current = "open";
			} else {
				window.setTimeout(() => {
					if (phaseRef.current === "enter") phaseRef.current = "open";
				}, SHEET_ENTER_MS);
			}
		};
		const enterFrame = window.requestAnimationFrame(() =>
			window.requestAnimationFrame(start),
		);

		return () => {
			cancelled = true;
			window.cancelAnimationFrame(enterFrame);
			if (exitTimerRef.current !== null) {
				window.clearTimeout(exitTimerRef.current);
				exitTimerRef.current = null;
			}
			stopDragRef.current?.();
			releasePresenceRef.current?.();
			releasePresenceRef.current = null;
			window.removeEventListener("click", onGhostClick, true);
			window.removeEventListener("keydown", onKeyDown);
			vv?.removeEventListener("resize", onViewport);
			vv?.removeEventListener("scroll", onViewport);
			previousFocus?.focus({ preventScroll: true });
		};
		// Mount-only: the layer unmounts when the exit animation finishes.
	}, []);

	useEffect(() => {
		if (!open) {
			playExitRef.current();
			return;
		}
		// A tap that lands while we are still sliding out must bring the sheet
		// back, not wait for unmount and a second press.
		if (phaseRef.current === "exit") playEnterRef.current();
	}, [open]);

	const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		beginPointer(event, true);
	};

	const onBodyPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		beginPointer(event, false);
	};

	const beginPointer = (
		event: ReactPointerEvent<HTMLDivElement>,
		fromHandle: boolean,
	) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		if (isTextEntry(event.target)) return;
		if (phaseRef.current === "exit") return;

		const panel = panelRef.current;
		if (!panel) return;

		// Grabbing mid-enter or mid-snap freezes the current pose so the finger
		// does not jump the sheet to rest and then follow.
		const interrupting =
			phaseRef.current === "enter" || phaseRef.current === "snap";
		let startY = event.clientY;
		if (interrupting) {
			paintTransition(panel, scrimRef.current, 0);
			const current = readTranslateY(panel);
			applyFrame(
				current,
				scrimOpacity(current, panel.getBoundingClientRect().height),
			);
			startY = event.clientY - current;
		}

		const session: DragSession = {
			pointerId: event.pointerId,
			startY,
			startX: event.clientX,
			fromHandle,
			mode: "pending",
			samples: [{ y: event.clientY, t: event.timeStamp }],
			height: panel.getBoundingClientRect().height,
			moved: false,
			interrupted: interrupting,
		};
		const onMove = (native: PointerEvent) => {
			if (native.pointerId !== session.pointerId) return;
			trackMove(session, native, panel);
		};
		const stop = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			if (stopDragRef.current === stop) stopDragRef.current = null;
		};
		const onUp = (native: PointerEvent) => {
			if (native.pointerId !== session.pointerId) return;
			stop();
			finishPointer(session, panel);
		};

		// Non-passive: once this is a drag we have to cancel the browser scroll.
		window.addEventListener("pointermove", onMove, { passive: false });
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		stopDragRef.current = stop;
	};

	const trackMove = (
		session: DragSession,
		native: PointerEvent,
		panel: HTMLDivElement,
	) => {
		session.samples.push({ y: native.clientY, t: native.timeStamp });
		if (session.samples.length > 8) session.samples.shift();

		const dy = native.clientY - session.startY;
		const dx = native.clientX - session.startX;

		if (session.mode === "pending") {
			if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
			if (Math.abs(dx) > Math.abs(dy)) {
				session.mode = "ignored";
				return;
			}
			const scrollTop = scrollRef.current?.scrollTop ?? 0;
			const canDragDown = session.fromHandle || scrollTop <= 1;
			if (dy < 0 && !session.fromHandle) {
				session.mode = "ignored";
				return;
			}
			if (dy > 0 && !canDragDown) {
				session.mode = "ignored";
				return;
			}
			session.mode = "dragging";
			session.moved = true;
			phaseRef.current = "drag";
			panel.setPointerCapture(session.pointerId);
			panel.dataset.dragging = "";
			paintTransition(panel, scrimRef.current, 0);
		}

		if (session.mode !== "dragging") return;
		native.preventDefault();
		const offset = applyDragOffset(dy, session.height);
		applyFrame(offset, scrimOpacity(offset, session.height));
	};

	const finishPointer = (session: DragSession, panel: HTMLDivElement) => {
		if (session.mode !== "dragging") {
			// A tap during enter froze the sheet mid-slide — finish the motion.
			if (session.interrupted) snapBack();
			return;
		}
		if (session.moved) {
			// Swallow the click this drag would synthesise. The trap expires on
			// its own so a drag that never produces a click cannot eat the next
			// tap on the FAB.
			ghostClickRef.current.arm();
		}
		try {
			panel.releasePointerCapture(session.pointerId);
		} catch {
			// Capture was never taken, or the pointer already left.
		}
		const velocity = velocityFromSamples(session.samples);
		if (shouldDismiss(offsetRef.current, velocity, session.height)) {
			tick();
			close();
			return;
		}
		snapBack();
	};

	return (
		<div ref={layerRef} className="mobile-sheet" data-slot="mobile-sheet">
			<div
				ref={scrimRef}
				aria-hidden
				className="mobile-sheet-scrim"
				onClick={close}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descriptionId : undefined}
				tabIndex={-1}
				className={cn(
					"mobile-sheet-panel flex max-h-[88dvh] flex-col gap-0 overflow-hidden rounded-t-[20px] bg-surface-secondary shadow-overlay outline-none",
					className,
				)}
				style={{ paddingBottom: "var(--safe-bottom)" }}
			>
				<div className="relative flex min-h-0 flex-col">
					{brandAccent ? <SheetBrandWash /> : null}

					{/* Grabber + title are the drag handle. The pill is decorative; the
					    whole band is the hit target, because a 4px bar is not a thumb target. */}
					<div
						data-sheet-drag
						className="relative z-10 flex shrink-0 cursor-grab touch-none flex-col items-stretch active:cursor-grabbing"
						onPointerDown={onHandlePointerDown}
					>
						<div className="flex justify-center pt-2.5 pb-1">
							<span
								aria-hidden
								data-sheet-handle
								className="h-1.5 w-10 rounded-full bg-foreground/25"
							/>
						</div>

						<div
							className={cn(
								"px-4 pt-2 pb-4 text-center",
								hideTitle && "sr-only",
							)}
						>
							<h2
								id={titleId}
								className="font-semibold text-foreground text-lg"
							>
								{title}
							</h2>
							{description ? (
								<p
									id={descriptionId}
									className="mt-1 text-muted-foreground text-sm"
								>
									{description}
								</p>
							) : null}
						</div>
					</div>

					<div
						ref={scrollRef}
						className="native-scroll relative z-10 min-h-0 flex-1"
						onPointerDown={onBodyPointerDown}
					>
						{children}
					</div>
				</div>
			</div>
		</div>
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

interface DragSession {
	pointerId: number;
	startY: number;
	startX: number;
	fromHandle: boolean;
	mode: "pending" | "dragging" | "ignored";
	samples: Array<{ y: number; t: number }>;
	height: number;
	moved: boolean;
	interrupted: boolean;
}

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	return (
		target.closest("input, textarea, select, [contenteditable='true']") !== null
	);
}

function trapFocus(panel: HTMLElement, event: KeyboardEvent) {
	const focusable = panel.querySelectorAll<HTMLElement>(
		'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
	);
	if (focusable.length === 0) {
		event.preventDefault();
		panel.focus();
		return;
	}
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (!first || !last) return;
	const active = document.activeElement;
	if (event.shiftKey && active === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && active === last) {
		event.preventDefault();
		first.focus();
	}
}

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function paintFrame(
	panel: HTMLElement | null,
	scrim: HTMLElement | null,
	offset: number,
	opacity: number,
) {
	if (panel) {
		panel.style.transform =
			offset === 0 ? "translate3d(0, 0, 0)" : `translate3d(0, ${offset}px, 0)`;
	}
	if (scrim) scrim.style.opacity = String(opacity);
}

function paintTransition(
	panel: HTMLElement | null,
	scrim: HTMLElement | null,
	ms: number,
) {
	const ease = "var(--ease-native)";
	const reduced = prefersReducedMotion();
	if (panel) {
		panel.style.transition = reduced ? "none" : `transform ${ms}ms ${ease}`;
	}
	if (scrim) {
		scrim.style.transition = reduced ? "none" : `opacity ${ms}ms ${ease}`;
	}
}

function liftForKeyboard(panel: HTMLElement) {
	const vv = window.visualViewport;
	const inset = vv
		? keyboardInset(window.innerHeight, vv.height, vv.offsetTop)
		: 0;
	panel.style.bottom = `${inset}px`;
	panel.style.maxHeight =
		inset > 0 ? `${Math.max(160, vv?.height ?? 160)}px` : "";
}

function readTranslateY(element: HTMLElement): number {
	const transform = getComputedStyle(element).transform;
	if (!transform || transform === "none") return 0;
	try {
		return new DOMMatrix(transform).m42;
	} catch {
		return 0;
	}
}

function tick() {
	try {
		navigator.vibrate?.(10);
	} catch {
		// iOS WebView rejects vibrate; a missing haptic is not a failure.
	}
}
