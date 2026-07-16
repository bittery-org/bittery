import { Easing, interpolate, useCurrentFrame } from "remotion";
import { AppScene, CURSOR, type SceneState } from "./scene";

export const FPS = 30;
export const DURATION_IN_FRAMES = 420; // 14s seamless loop

/* ── Script ─────────────────────────────────────────────────────────
   0        GitHub selected, cursor at rest (= final frame → loops)
   25–68    cursor glides to the password copy button
   72       click → copy flash, "Password copied" toast
   100–138  cursor to the Figma row
   142      click → Figma detail enters
   205–243  cursor back to the GitHub row
   247      click → GitHub detail enters
   268–305  cursor returns to rest, idle out                        */

const CLICK_FRAMES = [72, 142, 247];

const PATH: Array<{ at: number; x: number; y: number }> = [
	{ at: 0, ...CURSOR.rest },
	{ at: 25, ...CURSOR.rest },
	{ at: 68, ...CURSOR.passwordCopy },
	{ at: 100, ...CURSOR.passwordCopy },
	{ at: 138, ...CURSOR.row("figma") },
	{ at: 205, ...CURSOR.row("figma") },
	{ at: 243, ...CURSOR.row("github") },
	{ at: 268, ...CURSOR.row("github") },
	{ at: 305, ...CURSOR.rest },
	{ at: DURATION_IN_FRAMES, ...CURSOR.rest },
];

const glide = Easing.bezier(0.3, 0, 0.15, 1);

function cursorPosition(frame: number) {
	let segment = 0;
	for (let i = 0; i < PATH.length - 1; i++) {
		if (frame >= PATH[i].at) segment = i;
	}
	const from = PATH[segment];
	const to = PATH[segment + 1];
	const t =
		to.at === from.at
			? 0
			: glide(Math.min(1, Math.max(0, (frame - from.at) / (to.at - from.at))));
	return {
		x: from.x + (to.x - from.x) * t,
		y: from.y + (to.y - from.y) * t,
	};
}

function fade(frame: number, start: number, end: number) {
	return interpolate(frame, [start, end], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.out(Easing.cubic),
	});
}

function clickDip(frame: number) {
	let dip = 0;
	for (const click of CLICK_FRAMES) {
		dip = Math.max(
			dip,
			interpolate(frame, [click - 2, click + 1, click + 7], [0, 1, 0], {
				extrapolateLeft: "clamp",
				extrapolateRight: "clamp",
			}),
		);
	}
	return dip;
}

function stateAtFrame(frame: number): SceneState {
	const selectedId = frame < 142 ? "github" : frame < 247 ? "figma" : "github";
	const detailEnter =
		frame < 142
			? 1
			: frame < 247
				? fade(frame, 142, 158)
				: fade(frame, 247, 263);
	const passwordHover =
		Math.min(fade(frame, 52, 60), 1 - fade(frame, 108, 118)) *
		(frame < 142 ? 1 : 0);
	const copyPressed =
		interpolate(frame, [70, 73, 80, 92], [0, 1, 1, 0], {
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
		}) * 0.9;
	const toast = Math.min(fade(frame, 76, 88), 1 - fade(frame, 168, 184));
	return {
		selectedId,
		detailEnter,
		passwordHover,
		copyPressed,
		toast,
	};
}

function Cursor({ frame }: { frame: number }) {
	const { x, y } = cursorPosition(frame);
	const scale = 1 - clickDip(frame) * 0.14;
	return (
		<svg
			aria-hidden
			role="presentation"
			width="22"
			height="22"
			viewBox="0 0 24 24"
			className="absolute top-0 left-0 drop-shadow-[0_2px_4px_oklch(0_0_0/0.35)]"
			style={{
				transform: `translate(${x}px, ${y}px) scale(${scale})`,
				transformOrigin: "4px 3px",
			}}
		>
			<path
				d="M5 2.5v16.4l4.4-4 3 6.6 2.6-1.2-3-6.5h6L5 2.5Z"
				fill="white"
				stroke="oklch(0.2 0 0 / 0.9)"
				strokeWidth="1.3"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function HeroComposition() {
	const frame = useCurrentFrame();
	return (
		<div className="relative">
			<AppScene state={stateAtFrame(frame)} />
			<Cursor frame={frame} />
		</div>
	);
}
