/**
 * The single floating primary action per screen. Same gradient and glow as `BrandButton`.
 *
 * Positioned against the tab bar and the home indicator rather than the viewport, so it
 * never lands under either. It is a sibling of the scroll region, not a child, so it stays
 * put while the list moves.
 */

import { IconPlus } from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { Pressable } from "./pressable";
import { iconClass } from "./theme";

export function Fab({
	onPress,
	ariaLabel,
	/** Screens without a tab bar sit the FAB lower. */
	aboveTabBar = true,
	className,
}: {
	onPress: () => void;
	ariaLabel: string;
	aboveTabBar?: boolean;
	className?: string;
}) {
	return (
		<Pressable
			onClick={onPress}
			aria-label={ariaLabel}
			scale
			haptic={false}
			className={cn(
				"absolute right-5 z-30 flex size-14 items-center justify-center rounded-full",
				"bg-gradient-to-b from-primary to-primary-deep text-primary-foreground",
				"shadow-[inset_0_1px_0_0_rgb(255_255_255/0.22)] shadow-glow-lg",
				className,
			)}
			style={{
				bottom: aboveTabBar
					? "calc(var(--tab-bar-height) + var(--safe-bottom) + 16px)"
					: "calc(var(--safe-bottom) + 20px)",
			}}
		>
			<IconPlus className={iconClass.header} />
		</Pressable>
	);
}
