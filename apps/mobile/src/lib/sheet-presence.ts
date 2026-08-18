/**
 * What a presented sheet owes the document: drop the app out of the a11y tree, and
 * tell Android that the system back button now belongs to the top sheet.
 *
 * The back bridge is a `@JavascriptInterface` installed by `MainActivity.onWebViewCreate`,
 * same shape as `system-bars.ts`. It is absent in a browser, a desktop build and on iOS,
 * so every call is a no-op there. iOS dismisses by the drag, not by a back button.
 */

type BackHandler = () => void;

const backHandlers: BackHandler[] = [];

interface BackBridge {
	setEnabled: (enabled: boolean) => void;
}

function getBackBridge(): BackBridge | null {
	const bridge = (globalThis as { BitteryBack?: BackBridge }).BitteryBack;
	return typeof bridge?.setEnabled === "function" ? bridge : null;
}

function syncBackBridge() {
	try {
		getBackBridge()?.setEnabled(backHandlers.length > 0);
	} catch (error) {
		console.warn("[sheet] failed to sync back handler", error);
	}
}

function consumeBack(): boolean {
	const handler = backHandlers[backHandlers.length - 1];
	if (!handler) return false;
	handler();
	return true;
}

(globalThis as { __bitteryConsumeBack?: () => boolean }).__bitteryConsumeBack =
	consumeBack;

let inertCount = 0;

function acquireInert() {
	inertCount += 1;
	document.getElementById("root")?.setAttribute("inert", "");
}

function releaseInert() {
	inertCount = Math.max(0, inertCount - 1);
	if (inertCount === 0) {
		document.getElementById("root")?.removeAttribute("inert");
	}
}

/** Call once when a sheet mounts; the release undoes both the inert and the back claim. */
export function presentSheet(onBack: BackHandler): () => void {
	acquireInert();
	backHandlers.push(onBack);
	syncBackBridge();

	return () => {
		const index = backHandlers.lastIndexOf(onBack);
		if (index >= 0) backHandlers.splice(index, 1);
		syncBackBridge();
		releaseInert();
	};
}
