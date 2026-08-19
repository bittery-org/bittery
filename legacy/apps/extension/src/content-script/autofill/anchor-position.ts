/**
 * Shared anchor positioner for in-page overlays (the field icon and the autofill
 * dropdown).
 *
 * Both used to run their own `requestAnimationFrame` loop that called
 * `getBoundingClientRect()` on every frame for as long as a field was focused —
 * two forced layouts per frame, forever, on every page the extension touches.
 *
 * This module replaces that with an event-driven tracker:
 *
 * - Idle costs **zero frames**. Nothing is scheduled until something can
 *   actually move.
 * - Movement sources are observed directly: capture-phase `scroll` (so nested
 *   scroll containers count), window/visualViewport resize, and a shared
 *   `ResizeObserver` on each anchor plus the document element (which catches
 *   reflows from unrelated page mutations).
 * - Each event opens a short *settle window* of rAF ticks, so smooth scrolling
 *   and CSS transitions stay glued instead of snapping at the end.
 * - Every tick reads all anchors first and writes afterwards, so N overlays
 *   still cost a single layout pass rather than N.
 */

/** How long to keep sampling after the last movement signal. */
const SETTLE_MS = 350;

export interface AnchorHandle {
	/** Force an immediate reposition (e.g. right after showing the overlay). */
	refresh: () => void;
	/** Stop tracking. Safe to call more than once. */
	release: () => void;
}

interface AnchorEntry {
	element: HTMLElement;
	place: (rect: DOMRect) => void;
	onDetached?: () => void;
	lastKey: string;
}

const entries = new Set<AnchorEntry>();

/**
 * How many entries currently track each element.
 *
 * The field icon and the dropdown anchor to the *same* input, so unobserving on
 * the first release would silently stop resize notifications for the other.
 */
const observedCounts = new Map<HTMLElement, number>();

let resizeObserver: ResizeObserver | null = null;
let listenersAttached = false;
let rafId = 0;
let settleUntil = 0;

function rectKey(rect: DOMRect): string {
	return `${rect.top}:${rect.left}:${rect.width}:${rect.height}`;
}

/** Read every anchor, then write every anchor — never interleaved. */
function flush(force: boolean): void {
	if (entries.size === 0) return;

	const detached: AnchorEntry[] = [];
	const pending: Array<{ entry: AnchorEntry; rect: DOMRect }> = [];

	for (const entry of entries) {
		if (!entry.element.isConnected) {
			detached.push(entry);
			continue;
		}
		const rect = entry.element.getBoundingClientRect();
		const key = rectKey(rect);
		if (!force && key === entry.lastKey) continue;
		entry.lastKey = key;
		pending.push({ entry, rect });
	}

	for (const { entry, rect } of pending) {
		entry.place(rect);
	}

	for (const entry of detached) {
		release(entry);
		entry.onDetached?.();
	}
}

function tick(): void {
	rafId = 0;
	flush(false);
	if (performance.now() < settleUntil && entries.size > 0) {
		rafId = requestAnimationFrame(tick);
	}
}

/** Open (or extend) the settle window and make sure a frame is scheduled. */
function schedule(): void {
	if (entries.size === 0) return;
	settleUntil = performance.now() + SETTLE_MS;
	if (rafId === 0) {
		rafId = requestAnimationFrame(tick);
	}
}

function attachListeners(): void {
	if (listenersAttached) return;
	listenersAttached = true;

	// Capture phase so scrolling inside any nested container counts, passive so
	// we never delay the page's own scrolling.
	document.addEventListener("scroll", schedule, {
		capture: true,
		passive: true,
	});
	window.addEventListener("resize", schedule, { passive: true });
	window.visualViewport?.addEventListener("resize", schedule, {
		passive: true,
	});
	window.visualViewport?.addEventListener("scroll", schedule, {
		passive: true,
	});

	resizeObserver = new ResizeObserver(schedule);
	// The document element resizes whenever the page reflows, which is the cheap
	// proxy for "something moved that we didn't hear about".
	resizeObserver.observe(document.documentElement);
}

function detachListeners(): void {
	if (!listenersAttached) return;
	listenersAttached = false;

	document.removeEventListener("scroll", schedule, { capture: true });
	window.removeEventListener("resize", schedule);
	window.visualViewport?.removeEventListener("resize", schedule);
	window.visualViewport?.removeEventListener("scroll", schedule);

	resizeObserver?.disconnect();
	resizeObserver = null;
	observedCounts.clear();

	if (rafId !== 0) {
		cancelAnimationFrame(rafId);
		rafId = 0;
	}
}

function release(entry: AnchorEntry): void {
	if (!entries.delete(entry)) return;

	const remaining = (observedCounts.get(entry.element) ?? 1) - 1;
	if (remaining > 0) {
		observedCounts.set(entry.element, remaining);
	} else {
		observedCounts.delete(entry.element);
		resizeObserver?.unobserve(entry.element);
	}

	if (entries.size === 0) {
		detachListeners();
	}
}

/**
 * Keep `place` in sync with the on-screen box of `element`.
 *
 * `place` is called immediately, then again whenever the anchor's box changes.
 * When the anchor leaves the document the handle is released automatically and
 * `onDetached` fires.
 */
export function trackAnchor(options: {
	element: HTMLElement;
	place: (rect: DOMRect) => void;
	onDetached?: () => void;
}): AnchorHandle {
	attachListeners();

	const entry: AnchorEntry = {
		element: options.element,
		place: options.place,
		onDetached: options.onDetached,
		lastKey: "",
	};
	entries.add(entry);

	const observed = observedCounts.get(options.element) ?? 0;
	observedCounts.set(options.element, observed + 1);
	if (observed === 0) {
		resizeObserver?.observe(options.element);
	}

	const rect = options.element.getBoundingClientRect();
	entry.lastKey = rectKey(rect);
	options.place(rect);

	return {
		refresh: () => {
			if (!entries.has(entry)) return;
			const next = entry.element.getBoundingClientRect();
			entry.lastKey = rectKey(next);
			entry.place(next);
		},
		release: () => release(entry),
	};
}
