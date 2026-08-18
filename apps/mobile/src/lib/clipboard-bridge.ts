/**
 * `@bittery/shared/password#copyToClipboard` — the one copy path every `@bittery/ui` item-detail
 * field routes through (`handleCopy` in `packages/ui/src/components/vault/item-detail/shared.tsx`)
 * — calls `navigator.clipboard.writeText` directly. Shared code stays platform-agnostic (it has
 * no platform-injection seam for this), so a broken `navigator.clipboard` there cannot be fixed
 * from `packages/`.
 *
 * Tauri's Android WebView does not reliably expose a secure-context `navigator.clipboard`
 * (https://github.com/tauri-apps/tauri/issues/8628) — it can be entirely absent, or present but
 * throw on `writeText`. This installs a mobile-only polyfill in front of it: try the real Web
 * Clipboard API first (so nothing changes on platforms where it works), and fall back to
 * `@tauri-apps/plugin-clipboard-manager`, which talks to the native Android clipboard service
 * directly and bypasses the WebView, when the Web API is missing or rejects.
 *
 * Falls back per call rather than probing once at boot: a one-time probe would have to actually
 * write to the clipboard to be conclusive, which is an unwanted side effect to run unconditionally
 * on every launch.
 */
import { writeText as pluginWriteText } from "@tauri-apps/plugin-clipboard-manager";

export type ClipboardBridgePath = "web-api" | "plugin-fallback";

let lastPathLogged: ClipboardBridgePath | null = null;

function logPath(path: ClipboardBridgePath, detail?: unknown) {
	if (lastPathLogged === path) return;
	lastPathLogged = path;
	console.log(
		`[clipboard-bridge] writeText via ${path}${detail ? ` (${String(detail)})` : ""}`,
	);
}

function makeWriteTextWithFallback(
	nativeWriteText: ((text: string) => Promise<void>) | undefined,
): (text: string) => Promise<void> {
	return async (text: string) => {
		if (nativeWriteText) {
			try {
				await nativeWriteText(text);
				logPath("web-api");
				return;
			} catch (error) {
				console.warn(
					"[clipboard-bridge] navigator.clipboard.writeText failed, falling back to tauri-plugin-clipboard-manager",
					error,
				);
			}
		} else {
			console.warn(
				"[clipboard-bridge] navigator.clipboard is unavailable, using tauri-plugin-clipboard-manager",
			);
		}

		await pluginWriteText(text);
		logPath("plugin-fallback");
	};
}

/**
 * Installs the polyfill described above. Idempotent and cheap — safe to call once at app boot.
 * Captures the original (possibly absent) `navigator.clipboard.writeText` before overwriting the
 * property, so the fallback wrapper never calls back into itself.
 */
export function installClipboardBridge(): void {
	const nativeClipboard = window.navigator.clipboard;
	const nativeWriteText = nativeClipboard?.writeText?.bind(nativeClipboard);

	Object.defineProperty(window.navigator, "clipboard", {
		configurable: true,
		value: {
			...nativeClipboard,
			writeText: makeWriteTextWithFallback(nativeWriteText),
		},
	});

	console.log(
		`[clipboard-bridge] installed — isSecureContext=${window.isSecureContext}, native writeText present=${typeof nativeWriteText === "function"}`,
	);
}
