import { useCSSVariable } from "uniwind";

/** Shared spacing/size constants from DESIGN-NATIVE.md. */
export const layout = {
	screenPadding: 16,
	cardPadding: 14,
	rowHeight: 56,
	rowHeightCompact: 48,
	appBarHeight: 44,
	tabBarHeight: 52,
	iconTile: 40,
	iconTileLarge: 56,
	gap: { xs: 8, sm: 12, md: 16, lg: 24 },
} as const;

/** Icon sizes by context — keeps every bar and row visually aligned. */
export const iconSize = {
	chip: 16,
	row: 18,
	bar: 20,
	header: 24,
} as const;

/**
 * Brand tokens heroui's own `useThemeColor` doesn't know about because they are
 * Bittery additions in `global.css`.
 */
const BRAND_VARIABLES = {
	accentDeep: "--color-accent-deep",
	selected: "--color-selected",
	borderStrong: "--color-border-strong",
	info: "--color-info",
} as const;

export type BrandColor = keyof typeof BRAND_VARIABLES;

export function useBrandColor<const T extends readonly BrandColor[]>(
	names: T,
): { [K in keyof T]: string } {
	const values = useCSSVariable(names.map((name) => BRAND_VARIABLES[name]));
	return values.map((value) =>
		typeof value === "string" ? value : String(value),
	) as { [K in keyof T]: string };
}
