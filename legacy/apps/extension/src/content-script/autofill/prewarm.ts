/**
 * Prewarming for overlay iframes.
 *
 * Each overlay document is a full extension page — iframe navigation, React,
 * Tailwind and the Paraglide message bundle — which is 300-400ms before the
 * dropdown can paint. The pool makes every *subsequent* open instant, but the
 * first one on a page still lands after the user has already clicked a field.
 *
 * So we boot the frame when detection first finds a fillable field, which on a
 * real login page happens at document load. Pages with no fillable fields — the
 * overwhelming majority — never warm anything.
 *
 * Two rules keep this from becoming a tax on the host page:
 *
 * - Only the documents whose field kind was actually detected are warmed. A
 *   checkout page with card *and* address fields warms two frames, not all
 *   three, and a plain login page warms one.
 * - The work is deferred to idle time, so it never competes with the page's own
 *   load, and a tab that is not being looked at (restored session, background
 *   open, prerender) defers until it is.
 */

import { warmOverlay } from "./iframe-pool";

type OverlayKind = "credential" | "creditCard" | "identity";

const OVERLAY_DOCUMENTS: Record<
	OverlayKind,
	{ src: string; readyMessageType: string }
> = {
	credential: {
		src: "autofill-iframe.html",
		readyMessageType: "IFRAME_READY",
	},
	creditCard: {
		src: "credit-card-autofill-iframe.html",
		readyMessageType: "CC_IFRAME_READY",
	},
	identity: {
		src: "identity-autofill-iframe.html",
		readyMessageType: "IDENTITY_IFRAME_READY",
	},
};

/** Kinds already handled, so repeated detection passes cost one Set lookup. */
const requested = new Set<OverlayKind>();
/** Kinds waiting for the tab to become visible. */
const deferred = new Set<OverlayKind>();
let visibilityListenerAttached = false;

/**
 * A prerendering or hidden tab should not boot anything: the user may never
 * look at it, and prerender activation is exactly when the page needs its
 * budget. `document.prerendering` is Chrome-only and absent elsewhere.
 */
function isReadyToWarm(): boolean {
	return (
		!(document as Document & { prerendering?: boolean }).prerendering &&
		document.visibilityState === "visible"
	);
}

function whenIdle(run: () => void): void {
	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(run, { timeout: 2_000 });
		return;
	}
	setTimeout(run, 500);
}

function flushDeferred(): void {
	if (!isReadyToWarm()) return;

	document.removeEventListener("visibilitychange", flushDeferred);
	visibilityListenerAttached = false;

	const pending = [...deferred];
	deferred.clear();
	for (const kind of pending) {
		whenIdle(() => warm(kind));
	}
}

function warm(kind: OverlayKind): void {
	const document_ = OVERLAY_DOCUMENTS[kind];
	warmOverlay(document_.src, document_.readyMessageType);
}

/**
 * Note that the page has a fillable field of `kind`, and boot that overlay's
 * frame when there is spare time. Idempotent — call it from every detection
 * pass.
 */
export function prewarmOverlay(kind: OverlayKind): void {
	if (requested.has(kind)) return;
	requested.add(kind);

	if (!isReadyToWarm()) {
		deferred.add(kind);
		if (!visibilityListenerAttached) {
			visibilityListenerAttached = true;
			document.addEventListener("visibilitychange", flushDeferred);
		}
		return;
	}

	whenIdle(() => warm(kind));
}

/** Forget what has been warmed, so a navigation re-warms from scratch. */
export function resetOverlayPrewarm(): void {
	requested.clear();
	deferred.clear();
	if (visibilityListenerAttached) {
		document.removeEventListener("visibilitychange", flushDeferred);
		visibilityListenerAttached = false;
	}
}
