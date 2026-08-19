/**
 * Press feedback, the native way: a neutral highlight that appears instantly on touch-down
 * and a 0.985 scale on cards. Never a purple press state — see `DESIGN-NATIVE.md` § Press
 * feedback.
 *
 * Why not plain `active:` classes at the call site: a WebView only applies `:active` to a
 * `<button>` after it has decided the gesture is not a scroll, which lands ~100ms late and
 * reads as lag. Tracking `pointerdown` ourselves makes the highlight immediate, and
 * `pointercancel` (fired the moment the browser claims the gesture for scrolling) takes it
 * back so a flick down a list does not light up every row it passes.
 */

import { cn } from "@bittery/ui/lib/utils";
import {
	type ButtonHTMLAttributes,
	forwardRef,
	type PointerEvent as ReactPointerEvent,
	useState,
} from "react";

type Surface = "canvas" | "sheet";

export interface PressableProps
	extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
	/** `sheet` rows tint one rung higher, because a sheet already sits above the canvas. */
	surface?: Surface;
	/** Cards and tiles scale; full-bleed list rows only tint. */
	scale?: boolean;
	/** Turns the highlight off for controls that paint their own pressed state. */
	haptic?: boolean;
}

const HIGHLIGHT: Record<Surface, string> = {
	canvas: "bg-foreground/[0.055]",
	sheet: "bg-surface-tertiary",
};

export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(
	function Pressable(
		{
			surface = "canvas",
			scale = false,
			haptic = true,
			className,
			children,
			disabled,
			onPointerDown,
			onPointerUp,
			onPointerCancel,
			onPointerLeave,
			...props
		},
		ref,
	) {
		const [isPressed, setIsPressed] = useState(false);

		const track =
			(
				next: boolean,
				passthrough?: (event: ReactPointerEvent<HTMLButtonElement>) => void,
			) =>
			(event: ReactPointerEvent<HTMLButtonElement>) => {
				if (!disabled) setIsPressed(next);
				passthrough?.(event);
			};

		return (
			<button
				{...props}
				ref={ref}
				type="button"
				disabled={disabled}
				onPointerDown={track(true, onPointerDown)}
				onPointerUp={track(false, onPointerUp)}
				onPointerCancel={track(false, onPointerCancel)}
				onPointerLeave={track(false, onPointerLeave)}
				className={cn(
					"relative isolate touch-manipulation select-none outline-none transition-transform duration-150 ease-native",
					"focus-visible:ring-2 focus-visible:ring-ring/60",
					disabled && "opacity-50",
					scale && isPressed && !disabled && "scale-[0.985]",
					className,
				)}
			>
				{haptic && isPressed && !disabled ? (
					<span
						aria-hidden
						className={cn(
							"pointer-events-none absolute inset-0 -z-10 rounded-[inherit]",
							HIGHLIGHT[surface],
						)}
					/>
				) : null}
				{children}
			</button>
		);
	},
);

/**
 * Icon-only bar action: a 44pt touch target with a circular highlight, which is what every
 * app bar and toolbar in the app uses. The visual circle is smaller than the hit area on
 * purpose — Apple's HIG minimum is 44pt, but a 44pt grey disc next to a title looks heavy.
 */
export const BarButton = forwardRef<HTMLButtonElement, PressableProps>(
	function BarButton({ className, children, ...props }, ref) {
		return (
			<Pressable
				{...props}
				ref={ref}
				className={cn(
					"flex size-11 shrink-0 items-center justify-center rounded-full text-foreground",
					className,
				)}
			>
				{children}
			</Pressable>
		);
	},
);
