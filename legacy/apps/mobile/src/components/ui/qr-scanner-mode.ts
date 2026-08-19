/**
 * Turns the document into a transparent window over the native camera.
 *
 * `tauri-plugin-barcode-scanner` with `windowed: true` brings the WebView to
 * the front and clears its background. Anything still opaque in the page
 * hides the preview, so this class hides every portal except the overlay
 * and makes html/body transparent.
 */

export const QR_SCANNING_CLASS = "qr-scanning";
export const QR_SCANNER_OVERLAY_CLASS = "qr-scanner-overlay";

export function setQrScanningMode(active: boolean): void {
	const root = globalThis.document?.documentElement;
	if (!root) return;
	root.classList.toggle(QR_SCANNING_CLASS, active);
}

/** Two frames so the overlay is on screen before `scan({ windowed: true })`. */
export function waitForScannerOverlayPaint(): Promise<void> {
	if (typeof requestAnimationFrame !== "function") {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}
