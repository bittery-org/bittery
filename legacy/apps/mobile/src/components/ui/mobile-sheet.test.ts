import { describe, expect, test } from "bun:test";
import {
	applyDragOffset,
	createGhostClickSuppress,
	DISMISS_RATIO,
	DISMISS_VELOCITY_PX_PER_MS,
	keyboardInset,
	overlayProgress,
	rubberBand,
	SCRIM_OPACITY,
	scrimOpacity,
	shouldDismiss,
	velocityFromSamples,
} from "./mobile-sheet-motion";

describe("rubberBand", () => {
	test("zero overflow or dimension produces no travel", () => {
		expect(rubberBand(0, 400)).toBe(0);
		expect(rubberBand(80, 0)).toBe(0);
		expect(rubberBand(-10, 400)).toBe(0);
	});

	test("output is always less than the raw overflow", () => {
		expect(rubberBand(100, 400)).toBeLessThan(100);
		expect(rubberBand(400, 400)).toBeLessThan(200);
	});
});

describe("applyDragOffset", () => {
	test("downward travel is 1:1", () => {
		expect(applyDragOffset(120, 400)).toBe(120);
		expect(applyDragOffset(0, 400)).toBe(0);
	});

	test("upward travel is damped, never a bounce past the pull", () => {
		const pulled = applyDragOffset(-80, 400);
		expect(pulled).toBeLessThan(0);
		expect(pulled).toBeGreaterThan(-80);
	});
});

describe("shouldDismiss", () => {
	test("resting or upward offset never dismisses", () => {
		expect(shouldDismiss(0, 0, 400)).toBe(false);
		expect(shouldDismiss(-20, 2, 400)).toBe(false);
		expect(shouldDismiss(40, 0, 0)).toBe(false);
	});

	test("a short, slow drag stays open", () => {
		expect(shouldDismiss(40, 0.1, 400)).toBe(false);
	});

	test("crossing the distance ratio dismisses even when still", () => {
		expect(shouldDismiss(400 * DISMISS_RATIO, 0, 400)).toBe(true);
		expect(shouldDismiss(400 * DISMISS_RATIO - 1, 0, 400)).toBe(false);
	});

	test("a flick dismisses before the distance ratio", () => {
		expect(shouldDismiss(20, DISMISS_VELOCITY_PX_PER_MS, 400)).toBe(true);
		expect(shouldDismiss(20, DISMISS_VELOCITY_PX_PER_MS - 0.01, 400)).toBe(
			false,
		);
	});
});

describe("overlayProgress", () => {
	test("rest is fully dimmed, a full drag is clear", () => {
		expect(overlayProgress(0, 400)).toBe(1);
		expect(overlayProgress(400, 400)).toBe(0);
		expect(overlayProgress(200, 400)).toBe(0.5);
	});

	test("upward rubber-band does not over-dim", () => {
		expect(overlayProgress(-40, 400)).toBe(1);
	});

	test("scrim opacity tracks the same progress", () => {
		expect(scrimOpacity(0, 400)).toBe(SCRIM_OPACITY);
		expect(scrimOpacity(400, 400)).toBe(0);
		expect(scrimOpacity(200, 400)).toBe(SCRIM_OPACITY * 0.5);
	});
});

describe("velocityFromSamples", () => {
	test("needs two samples", () => {
		expect(velocityFromSamples([])).toBe(0);
		expect(velocityFromSamples([{ y: 10, t: 1 }])).toBe(0);
	});

	test("uses the last window of samples, not the whole gesture", () => {
		const samples = [
			{ y: 0, t: 0 },
			{ y: 10, t: 100 },
			{ y: 20, t: 200 },
			{ y: 50, t: 240 },
		];
		// Last 80ms is 20 → 50 over 40ms = 0.75 px/ms, not the slow start.
		expect(velocityFromSamples(samples, 80)).toBeCloseTo(0.75);
	});
});

describe("createGhostClickSuppress", () => {
	test("the click that belongs to the drag is swallowed", () => {
		const timers: Array<() => void> = [];
		const suppress = createGhostClickSuppress(
			50,
			(fn) => {
				timers.push(fn);
				return timers.length - 1;
			},
			() => undefined,
		);
		suppress.arm();
		expect(suppress.consume()).toBe(true);
		expect(suppress.consume()).toBe(false);
	});

	test("a leftover arm expires so the next real tap still opens the sheet", () => {
		const timers: Array<() => void> = [];
		const suppress = createGhostClickSuppress(
			50,
			(fn) => {
				timers.push(fn);
				return timers.length - 1;
			},
			() => undefined,
		);
		suppress.arm();
		expect(suppress.armed).toBe(true);
		// Browser never synthesised a click (the drag travelled too far).
		for (const fire of timers) fire();
		expect(suppress.armed).toBe(false);
		expect(suppress.consume()).toBe(false);
	});
});

describe("keyboardInset", () => {
	test("no keyboard leaves the sheet on the home indicator", () => {
		expect(keyboardInset(800, 800, 0)).toBe(0);
	});

	test("a resized visual viewport lifts the sheet by the stolen band", () => {
		expect(keyboardInset(800, 500, 0)).toBe(300);
	});

	test("a panned visual viewport still reports the gap under it", () => {
		expect(keyboardInset(800, 500, 120)).toBe(180);
	});
});
