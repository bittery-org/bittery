/**
 * Pooled overlay iframes.
 *
 * Every overlay iframe is a full extension page: React, the Tailwind stylesheet
 * and the Paraglide message bundle all boot from scratch. Creating one per field
 * focus meant the dropdown could not appear until that boot finished — and the
 * user pays it again on every focus, every tab-between-fields, every reopen.
 *
 * So we keep one warm frame per overlay document and swap its contents instead.
 * The first open is unchanged; every later one is a `postMessage` away.
 *
 * Three consequences are handled deliberately:
 *
 * - **Readiness.** A frame announces itself exactly once, on mount. If that
 *   happened while nobody was listening (focus, then blur before boot finished),
 *   a consumer-owned handshake would deadlock and the frame would never receive
 *   its items. So the *pool* owns the ready listener for the frame's whole life,
 *   and messages posted before then are queued.
 * - **Stale secrets.** A hidden-but-alive frame would otherwise hold the last
 *   decrypted items in memory. `hide()` posts `OVERLAY_CLEAR` so the frame drops
 *   them, and an idle frame is destroyed outright after {@link IDLE_EVICT_MS}.
 * - **Nonce lifetime.** The nonce is per-frame rather than per-open. It exists to
 *   bind messages to *this* frame (both ends are the extension origin), and a
 *   fresh frame after eviction gets a fresh nonce.
 */

import {
	appendNonceToIframeSrc,
	createIframeNonce,
} from "../../lib/iframe-nonce";
import {
	applyOverlayFrameChrome,
	applyOverlayHostChrome,
	OVERLAY_MIN_WIDTH_PX,
} from "../overlay-chrome";

/** How long a hidden frame is kept warm before it is torn down. */
const IDLE_EVICT_MS = 45_000;
/**
 * How long a *prewarmed* frame is kept before teardown.
 *
 * Longer than {@link IDLE_EVICT_MS}: this frame has never been shown, so the
 * clock starts at page load rather than at the user's last interaction, and a
 * user who lands on a login form may take a while to reach it. It also holds no
 * decrypted items, so the only cost of keeping it is memory.
 */
const WARM_EVICT_MS = 180_000;
/** Matches the overlay fade in `createEntry`. */
const FADE_OUT_MS = 130;

export interface PooledOverlay {
	/** Fixed-position shadow host. Position it; never re-parent it. */
	readonly host: HTMLElement;
	readonly iframe: HTMLIFrameElement;
	readonly nonce: string;
	readonly origin: string;
	/** Post to the frame, queueing until it has announced itself. */
	post(message: Record<string, unknown>): void;
	setHeight(px: number): void;
	show(): void;
	hide(): void;
}

interface PoolEntry extends PooledOverlay {
	host: HTMLElement;
	iframe: HTMLIFrameElement;
	isReady: boolean;
	queue: Array<Record<string, unknown>>;
	evictTimeout: ReturnType<typeof setTimeout> | null;
	fadeTimeout: ReturnType<typeof setTimeout> | null;
	visible: boolean;
	teardown: () => void;
}

const pool = new Map<string, PoolEntry>();

function createEntry(src: string, readyMessageType: string): PoolEntry {
	const host = document.createElement("div");
	host.style.position = "fixed";
	host.style.zIndex = "2147483647";
	host.style.display = "none";
	host.style.opacity = "0";
	host.style.transform = "translateY(-6px)";
	host.style.transition = `opacity ${FADE_OUT_MS}ms ease-out, transform ${FADE_OUT_MS}ms ease-out`;
	applyOverlayHostChrome(host);
	document.body.appendChild(host);

	const shadow = host.attachShadow({ mode: "open" });

	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "0px";
	iframe.style.display = "block";
	iframe.style.background = "transparent";
	iframe.style.colorScheme = "normal";
	applyOverlayFrameChrome(iframe);
	iframe.setAttribute("allowtransparency", "true");
	iframe.setAttribute("title", "Bittery");

	const nonce = createIframeNonce();
	iframe.src = appendNonceToIframeSrc(chrome.runtime.getURL(src), nonce);
	shadow.appendChild(iframe);

	const origin = new URL(iframe.src).origin;

	const flushQueue = () => {
		for (const message of entry.queue) {
			entry.iframe.contentWindow?.postMessage(message, origin);
		}
		entry.queue.length = 0;
	};

	// Owned by the pool, not the consumer: the frame only announces itself once,
	// and the consumer that triggered the boot may already be gone by then.
	const onReady = (event: MessageEvent) => {
		if (
			event.source !== entry.iframe.contentWindow ||
			event.origin !== origin ||
			event.data?.type !== readyMessageType ||
			event.data?.nonce !== nonce ||
			entry.isReady
		) {
			return;
		}
		entry.isReady = true;
		flushQueue();
	};
	window.addEventListener("message", onReady);

	const entry: PoolEntry = {
		host,
		iframe,
		nonce,
		origin,
		isReady: false,
		queue: [],
		evictTimeout: null,
		fadeTimeout: null,
		visible: false,
		teardown: () => window.removeEventListener("message", onReady),
		post(message) {
			const payload = { ...message, nonce };
			if (!entry.isReady) {
				entry.queue.push(payload);
				return;
			}
			entry.iframe.contentWindow?.postMessage(payload, origin);
		},
		setHeight(px) {
			entry.iframe.style.height = `${px}px`;
		},
		show() {
			if (entry.evictTimeout !== null) {
				clearTimeout(entry.evictTimeout);
				entry.evictTimeout = null;
			}
			if (entry.fadeTimeout !== null) {
				clearTimeout(entry.fadeTimeout);
				entry.fadeTimeout = null;
			}
			entry.visible = true;
			entry.host.style.display = "block";
			// Undo the prewarm parking spot (see `warmOverlay`). The caller has
			// already positioned the host by the time `show` runs.
			entry.host.style.visibility = "visible";
			entry.host.style.pointerEvents = "auto";
			// Force a style flush so the transition runs from the hidden state.
			void entry.host.offsetHeight;
			entry.host.style.opacity = "1";
			entry.host.style.transform = "translateY(0)";
		},
		hide() {
			if (!entry.visible) return;
			entry.visible = false;
			entry.host.style.opacity = "0";
			entry.host.style.transform = "translateY(-6px)";
			entry.post({ type: "OVERLAY_CLEAR" });

			entry.fadeTimeout = setTimeout(() => {
				entry.fadeTimeout = null;
				if (!entry.visible) {
					entry.host.style.display = "none";
				}
			}, FADE_OUT_MS);
			entry.evictTimeout = setTimeout(() => destroyEntry(src), IDLE_EVICT_MS);
		},
	};

	return entry;
}

function destroyEntry(src: string): void {
	const entry = pool.get(src);
	if (!entry || entry.visible) return;
	pool.delete(src);
	if (entry.evictTimeout !== null) clearTimeout(entry.evictTimeout);
	if (entry.fadeTimeout !== null) clearTimeout(entry.fadeTimeout);
	entry.teardown();
	entry.host.remove();
}

/**
 * Get the warm frame for `src`, creating it on first use.
 *
 * `readyMessageType` is the message the frame posts once it has mounted; it is a
 * constant per document, and the pool listens for it on the caller's behalf.
 */
export function acquireOverlay(
	src: string,
	readyMessageType: string,
): PooledOverlay {
	const existing = pool.get(src);
	if (existing?.host.isConnected) {
		return existing;
	}
	const entry = createEntry(src, readyMessageType);
	pool.set(src, entry);
	return entry;
}

/**
 * Boot the frame for `src` ahead of time without showing it.
 *
 * The first open costs 300-400ms of iframe navigation plus React, Tailwind and
 * the message bundle booting, and the user waits that out staring at a field
 * they just clicked. Calling this once the page is known to *have* a fillable
 * field moves that cost to load time, where nothing is waiting on it.
 *
 * Safe by construction: a warmed frame is never sent an items message, so there
 * is nothing in it to clear. It is torn down after {@link WARM_EVICT_MS} unless
 * `show()` claims it first.
 */
export function warmOverlay(src: string, readyMessageType: string): void {
	if (pool.get(src)?.host.isConnected) return;

	const entry = createEntry(src, readyMessageType);

	// Deliberately *not* `display: none`, which is how an already-shown frame
	// hides. A frame with no layout box reports a content height of zero, so the
	// overlay's own ResizeObserver would have nothing to measure and the first
	// show would paint an empty box. Park it off-screen instead: laid out and
	// measured, but invisible and untouchable. `show()` undoes all three.
	entry.host.style.display = "block";
	entry.host.style.visibility = "hidden";
	entry.host.style.pointerEvents = "none";
	entry.host.style.top = "0px";
	entry.host.style.left = "-10000px";
	// Lay out at the width it will most likely be shown at, so the height the
	// frame reports on boot is the height it will actually need.
	entry.host.style.width = `${OVERLAY_MIN_WIDTH_PX}px`;

	pool.set(src, entry);
	entry.evictTimeout = setTimeout(() => destroyEntry(src), WARM_EVICT_MS);
}

/** Look up an already-warm frame without creating one. */
export function peekOverlay(src: string): PooledOverlay | null {
	const entry = pool.get(src);
	return entry?.host.isConnected ? entry : null;
}

/** Tear down every pooled frame (page unload, extension lock). */
export function destroyOverlayPool(): void {
	for (const [src, entry] of [...pool]) {
		entry.visible = false;
		destroyEntry(src);
	}
	pool.clear();
}
