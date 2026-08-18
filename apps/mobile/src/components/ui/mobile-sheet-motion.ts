/**
 * Drag physics for `MobileSheet`. Kept pure so the thresholds can be tested without a
 * WebView — a dismiss that fires too early or a rubber-band that feels like a bounce is
 * a spec bug, not a styling one.
 *
 * Timings are longer than the 220ms system pulse on purpose: the sheet travels the full
 * height of the screen, and 220ms over that distance reads as a website fade. Exit stays
 * at 220ms so existing "wait for the sheet to leave, then open the next one" callers
 * (`runAction`, form resets) keep lining up.
 */

export const SHEET_ENTER_MS = 400;
export const SHEET_EXIT_MS = 220;
export const SHEET_SNAP_MS = 280;

/** Downward travel, as a fraction of the sheet's height, that dismisses on release. */
export const DISMISS_RATIO = 0.28;

/** Downward speed (px/ms) that dismisses even if travel is short. ~550 px/s. */
export const DISMISS_VELOCITY_PX_PER_MS = 0.55;

/** WebKit's rubber-band constant — resistance when pulling the sheet *up* past rest. */
export const RUBBER_BAND_CONSTANT = 0.55;

/** Finger travel before we decide drag vs scroll. */
export const DRAG_SLOP_PX = 8;

/** Resting scrim opacity. Lighter than a desktop modal — a phone dims, it does not black out. */
export const SCRIM_OPACITY = 0.4;

export function rubberBand(
	overflow: number,
	dimension: number,
	constant = RUBBER_BAND_CONSTANT,
): number {
	if (overflow <= 0 || dimension <= 0) return 0;
	return (overflow * dimension * constant) / (dimension + constant * overflow);
}

/** Map a raw finger delta onto the sheet: 1:1 down, damped up. */
export function applyDragOffset(rawDy: number, height: number): number {
	if (rawDy >= 0) return rawDy;
	return -rubberBand(-rawDy, height);
}

export function shouldDismiss(
	offset: number,
	velocity: number,
	height: number,
): boolean {
	if (offset <= 0 || height <= 0) return false;
	if (velocity >= DISMISS_VELOCITY_PX_PER_MS) return true;
	return offset / height >= DISMISS_RATIO;
}

/** 1 at rest, 0 when the sheet has been dragged fully off-screen. */
export function overlayProgress(offset: number, height: number): number {
	if (height <= 0) return 1;
	return 1 - Math.min(Math.max(offset, 0) / height, 1);
}

export function scrimOpacity(offset: number, height: number): number {
	return SCRIM_OPACITY * overlayProgress(offset, height);
}

export function velocityFromSamples(
	samples: ReadonlyArray<{ y: number; t: number }>,
	windowMs = 80,
): number {
	if (samples.length < 2) return 0;
	const last = samples[samples.length - 1];
	if (!last) return 0;

	let first = samples[0];
	if (!first) return 0;
	for (let i = samples.length - 2; i >= 0; i--) {
		const candidate = samples[i];
		if (!candidate) break;
		if (last.t - candidate.t > windowMs) break;
		first = candidate;
	}

	const dt = last.t - first.t;
	if (dt <= 0) return 0;
	return (last.y - first.y) / dt;
}

/** Pixels the keyboard has stolen from the bottom of the layout viewport. */
export function keyboardInset(
	innerHeight: number,
	visualHeight: number,
	visualOffsetTop: number,
): number {
	return Math.max(0, innerHeight - visualHeight - visualOffsetTop);
}

/**
 * How long a "this drag should not also click" trap may stay armed.
 *
 * A real click after `pointerup` lands in the same turn or the next. Anything later
 * is the user's next tap — and if we still swallow it, opening a sheet takes two
 * or three presses.
 */
export const GHOST_CLICK_TTL_MS = 50;

/**
 * One-shot trap for the click a drag would otherwise synthesise. `consume()` is
 * true only while the trap is armed; it expires itself so a leftover arm cannot
 * eat the next real tap.
 */
export function createGhostClickSuppress(
	ttlMs = GHOST_CLICK_TTL_MS,
	schedule: (fn: () => void, ms: number) => unknown = (fn, ms) =>
		window.setTimeout(fn, ms),
	cancel: (id: unknown) => void = (id) => window.clearTimeout(id as number),
) {
	let armed = false;
	let timer: unknown = null;

	const disarm = () => {
		armed = false;
		if (timer !== null) {
			cancel(timer);
			timer = null;
		}
	};

	return {
		arm() {
			armed = true;
			if (timer !== null) cancel(timer);
			timer = schedule(disarm, ttlMs);
		},
		consume(): boolean {
			if (!armed) return false;
			disarm();
			return true;
		},
		get armed() {
			return armed;
		},
	};
}
