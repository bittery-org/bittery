import { useTheme } from "next-themes";
import { useEffect } from "react";

/**
 * Keeps the Rust-side UI theme preference in sync with next-themes.
 *
 * next-themes only persists the appearance setting to the webview's
 * localStorage, which the native host (a separate process) cannot read. By
 * mirroring the value into the Tauri-managed store we let the native host
 * report the desktop appearance to the browser extension — even before this
 * window has loaded — and broadcast a `theme_changed` event to subscribers.
 *
 * Renders nothing.
 */
export function ThemeSync() {
	const { theme } = useTheme();

	useEffect(() => {
		if (theme !== "light" && theme !== "dark" && theme !== "system") {
			return;
		}

		let cancelled = false;
		void (async () => {
			try {
				const { invoke } = await import("@tauri-apps/api/core");
				if (!cancelled) {
					await invoke("set_ui_theme", { theme });
				}
			} catch (error) {
				console.error("[theme-sync] Failed to sync UI theme:", error);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [theme]);

	return null;
}
