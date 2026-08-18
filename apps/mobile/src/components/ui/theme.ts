/**
 * Shared sizing constants, ported from `apps/mobile/src/components/ui/theme.ts` so both
 * mobile apps lay out identically. See `apps/mobile/DESIGN-NATIVE.md` § Layout constants.
 */

export const layout = {
	screenPadding: 16,
	cardPadding: 14,
	rowHeight: 56,
	rowHeightCompact: 48,
	appBarHeight: 52,
	tabBarHeight: 54,
	iconTile: 40,
	iconTileLarge: 56,
} as const;

/** Icon sizes by context — this is what keeps every bar and row optically aligned. */
export const iconSize = {
	chip: 16,
	row: 18,
	bar: 20,
	header: 24,
} as const;

/**
 * Tailwind size classes matching `iconSize`. Icons here are `lucide-react` SVGs sized by
 * class rather than by prop, so call sites stay declarative.
 */
export const iconClass = {
	chip: "size-4",
	row: "size-[18px]",
	bar: "size-5",
	header: "size-6",
} as const;

/**
 * Bottom padding a scroll region needs so its last row clears the tab bar and the gesture
 * area. Mirrors native's `useBottomInset()`; a plain value because CSS can do the insets.
 */
export const scrollBottomInset = {
	/** Screens with a tab bar below the scroller. */
	tabBar: "calc(var(--tab-bar-height) + var(--safe-bottom) + 24px)",
	/** Pushed screens with nothing below the scroller. */
	plain: "calc(var(--safe-bottom) + 24px)",
} as const;
