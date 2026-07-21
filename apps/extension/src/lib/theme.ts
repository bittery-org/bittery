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

export function readAppliedTheme(): ResolvedTheme | null {
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

/**
 * Toggle the `.dark` class on the document root.
 *
 * `colorScheme` is opt-in because it is *not* safe in the in-page overlay
 * frames: `color-scheme: dark` makes the browser paint an opaque dark canvas
 * for the document, which wins over `background: transparent` and puts a black
 * box behind the floating card on the host page. The overlays get the `.dark`
 * class (which is all the design tokens need) and leave `color-scheme` alone.
 */
function paintResolvedTheme(
	theme: ResolvedTheme,
	options?: { colorScheme?: boolean },
): void {
	const root = globalThis.document?.documentElement;
	if (!root) return;
	root.classList.toggle("dark", theme === "dark");
	if (options?.colorScheme !== false) {
		root.style.colorScheme = theme;
	}
}

/** Paint the theme and record it as the no-flash cache for the next open. */
export function applyResolvedTheme(theme: ResolvedTheme): void {
	paintResolvedTheme(theme);
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

/**
 * Resolve the theme for an in-page overlay document (the autofill/passkey/save
 * iframes). Those documents share the popup's extension origin, so the popup's
 * `localStorage` is readable synchronously — no background round-trip, no flash.
 *
 * An explicit "light"/"dark" preference always wins. Under "system" we prefer
 * the popup's last *resolved* theme, because that value also encodes a
 * desktop-app-managed override the overlay can't see; it falls back to the OS
 * setting when the popup has never run.
 */
function resolveOverlayTheme(): ResolvedTheme {
	const preference = readStoredThemePreference();
	if (preference !== "system") {
		return preference;
	}
	return readAppliedTheme() ?? getSystemTheme();
}

/**
 * Apply the overlay theme before first paint and keep it in sync afterwards.
 *
 * Both listeners are passive: the OS `matchMedia` change and the cross-document
 * `storage` event (fired when the popup writes a new preference). Nothing polls,
 * so an idle overlay costs zero frames.
 */
export function startOverlayTheme(): () => void {
	// Never writes the applied-theme cache: the overlay is a *reader* of the
	// popup's decision and must not overwrite a desktop-managed value it can't see.
	paintResolvedTheme(resolveOverlayTheme(), { colorScheme: false });

	const reapply = () =>
		paintResolvedTheme(resolveOverlayTheme(), { colorScheme: false });

	const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
	media?.addEventListener("change", reapply);

	const onStorage = (event: StorageEvent) => {
		if (
			event.key === null ||
			event.key === THEME_PREFERENCE_KEY ||
			event.key === THEME_APPLIED_KEY
		) {
			reapply();
		}
	};
	globalThis.addEventListener?.("storage", onStorage);

	return () => {
		media?.removeEventListener("change", reapply);
		globalThis.removeEventListener?.("storage", onStorage);
	};
}
