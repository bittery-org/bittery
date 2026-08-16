/**
 * The primary action: `primary → primary-deep` vertical gradient, a 1px top inset highlight
 * and a purple glow in dark mode. There is exactly one of these per screen, and "the purple
 * thing" therefore always means "the thing you came here to do".
 *
 * Do not rebuild it out of `<Button variant="default">` plus classes.
 */

import { cn } from "@bittery/ui/lib/utils";
import type { ReactNode } from "react";
import { Pressable, type PressableProps } from "./pressable";

const HEIGHTS = { md: "h-11", lg: "h-13" } as const;

interface BrandButtonProps extends Omit<PressableProps, "children"> {
	label: ReactNode;
	isLoading?: boolean;
	/** Full-bleed inside its container; the default for form submits. */
	fullWidth?: boolean;
	size?: keyof typeof HEIGHTS;
	leading?: ReactNode;
}

export function BrandButton({
	label,
	isLoading = false,
	fullWidth = true,
	size = "md",
	leading,
	disabled,
	className,
	...props
}: BrandButtonProps) {
	const inert = disabled || isLoading;

	return (
		<Pressable
			{...props}
			disabled={inert}
			scale
			haptic={false}
			className={cn(
				"flex items-center justify-center gap-2 overflow-hidden rounded-xl px-5",
				"bg-gradient-to-b from-primary to-primary-deep text-primary-foreground",
				"font-semibold text-base",
				// The inset highlight is what stops a flat gradient reading as a coloured box.
				"shadow-[inset_0_1px_0_0_rgb(255_255_255/0.22)]",
				!inert && "dark:shadow-glow",
				HEIGHTS[size],
				fullWidth ? "w-full" : "self-start",
				className,
			)}
		>
			{isLoading ? (
				<span
					aria-hidden
					className="size-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
				/>
			) : (
				leading
			)}
			{label}
		</Pressable>
	);
}
