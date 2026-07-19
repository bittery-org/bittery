/**
 * Extension Theme Module
 *
 * The popup persists the user's theme *preference* ("light" | "dark" |
 * "system") in `localStorage`, which is synchronously readable inside the
 * popup document. That lets us apply the correct theme before React's first
 * paint and avoid a flash of the wrong theme.
 *
 * We additionally cache the last *resolved* theme ("light" | "dark") so the
 * early-paint script can honour a desktop-managed override (or a resolved
 * "system" value) without waiting on the async desktop status round-trip.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** User preference, mirrors next-themes' vocabulary on web/desktop. */
export const THEME_PREFERENCE_KEY = "bittery-theme";
/** Last applied resolved theme, used purely for no-flash early paint. */
export const THEME_APPLIED_KEY = "bittery-theme-applied";

const DEFAULT_PREFERENCE: ThemePreference = "system";

function isThemePreference(value: unknown): value is ThemePreference {
	return value === "light" || value === "dark" || value === "system";
}

function isResolvedTheme(value: unknown): value is ResolvedTheme {
	return value === "light" || value === "dark";
}

/** Synchronously read the stored theme preference (defaults to "system"). */
export function readStoredThemePreference(): ThemePreference {
	try {
		const raw = globalThis.localStorage?.getItem(THEME_PREFERENCE_KEY);
		if (isThemePreference(raw)) {
			return raw;
		}
	} catch {
		// localStorage may be unavailable in some contexts; fall through.
	}
	return DEFAULT_PREFERENCE;
}

export function writeStoredThemePreference(preference: ThemePreference): void {
	try {
		globalThis.localStorage?.setItem(THEME_PREFERENCE_KEY, preference);
	} catch {
		// Ignore persistence failures.
	}
}

function readAppliedTheme(): ResolvedTheme | null {
	try {
		const raw = globalThis.localStorage?.getItem(THEME_APPLIED_KEY);
		return isResolvedTheme(raw) ? raw : null;
	} catch {
		return null;
	}
}

function writeAppliedTheme(theme: ResolvedTheme): void {
	try {
		globalThis.localStorage?.setItem(THEME_APPLIED_KEY, theme);
	} catch {
		// Ignore persistence failures.
	}
}

/** Resolve the OS-level color scheme via matchMedia (defaults to "light"). */
export function getSystemTheme(): ResolvedTheme {
	try {
		return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	} catch {
		return "light";
	}
}

/** Collapse a preference into a concrete resolved theme. */
export function resolvePreference(preference: ThemePreference): ResolvedTheme {
	return preference === "system" ? getSystemTheme() : preference;
}

/** Toggle the `.dark` class + `color-scheme` on the document root. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
	const root = globalThis.document?.documentElement;
	if (!root) return;
	root.classList.toggle("dark", theme === "dark");
	root.style.colorScheme = theme;
	writeAppliedTheme(theme);
}

/**
 * Apply the best-known theme before React renders. Prefers the cached resolved
 * theme (which may reflect a desktop override) and falls back to resolving the
 * stored preference. Safe to call synchronously at module load.
 */
export function applyEarlyTheme(): void {
	const cached = readAppliedTheme();
	applyResolvedTheme(cached ?? resolvePreference(readStoredThemePreference()));
}
