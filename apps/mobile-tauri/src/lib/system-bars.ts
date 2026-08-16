/**
 * Keeps the Android status and navigation bar glyphs legible against the app's own canvas.
 *
 * The app draws edge-to-edge, so the bars sit directly on `--background`. Android will not
 * work out what colour to draw its clock and its gesture pill — it has to be told, and only
 * the web app knows which theme is actually showing (`next-themes`, plus an in-app Dark Mode
 * switch that can disagree with the system night mode).
 *
 * The bridge is a `@JavascriptInterface` installed by `MainActivity.onWebViewCreate`. It is
 * absent everywhere else — a browser, a desktop build, iOS — so every call is a no-op there.
 */

interface SystemBarsBridge {
	setDark: (isDark: boolean) => void;
}

function getBridge(): SystemBarsBridge | null {
	const bridge = (globalThis as { BitterySystemBars?: SystemBarsBridge })
		.BitterySystemBars;
	return typeof bridge?.setDark === "function" ? bridge : null;
}

export function syncSystemBars(isDark: boolean): void {
	try {
		getBridge()?.setDark(isDark);
	} catch (error) {
		// A bar that stays the wrong colour is a blemish, never a reason to break a render.
		console.warn("[system-bars] failed to sync appearance", error);
	}
}
