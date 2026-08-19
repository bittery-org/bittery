import type { AutofillField } from "../types";
import { type AnchorHandle, trackAnchor } from "./anchor-position";

const ICON_SIZE_PX = 22;

/**
 * Detect if the input has sibling elements (e.g. password show/hide toggle)
 * overlapping its right side, and return the appropriate right offset for the icon.
 *
 * This reads computed style and walks the input's siblings, so it is measured
 * once when the icon is created and cached — the position tracker reuses the
 * result instead of recomputing it on every move.
 */
function getInputRightOffset(input: HTMLInputElement): number {
	const BASE_OFFSET = 30;
	const inputRect = input.getBoundingClientRect();
	let maxOverlap = 0;

	const paddingRight =
		Number.parseFloat(window.getComputedStyle(input).paddingRight) || 0;
	if (paddingRight > 35) {
		maxOverlap = Math.max(maxOverlap, paddingRight - 16);
	}

	const parent = input.parentElement;
	if (parent) {
		for (const el of parent.children) {
			if (el === input || !(el instanceof HTMLElement)) continue;
			const elRect = el.getBoundingClientRect();
			if (elRect.width === 0 || elRect.height === 0) continue;

			const isNearRightEdge = elRect.left >= inputRect.right - 60;
			const isVerticallyAligned =
				elRect.top < inputRect.bottom && elRect.bottom > inputRect.top;

			if (isNearRightEdge && isVerticallyAligned) {
				const overlap = inputRect.right - elRect.left;
				if (overlap > 0) {
					maxOverlap = Math.max(maxOverlap, overlap + 2);
				}
			}
		}
	}

	return BASE_OFFSET + maxOverlap;
}

/**
 * Decide whether the icon sits on a dark surface.
 *
 * The icon lives on the *host page*, not in our own UI, so the extension's
 * light/dark preference is the wrong signal — a dark Bittery on a white login
 * form would be invisible. Instead we walk up from the input until we find the
 * first non-transparent background and judge its luminance. One measurement per
 * icon, cached for its lifetime.
 */
function isOnDarkSurface(input: HTMLInputElement): boolean {
	let node: HTMLElement | null = input;
	let depth = 0;

	while (node && depth < 6) {
		const parsed = parseRgb(window.getComputedStyle(node).backgroundColor);
		if (parsed && parsed.alpha > 0.1) {
			// Rec. 709 luma, good enough to pick between two icon tints.
			const luma =
				(0.2126 * parsed.r + 0.7152 * parsed.g + 0.0722 * parsed.b) / 255;
			return luma < 0.45;
		}
		node = node.parentElement;
		depth += 1;
	}

	return false;
}

function parseRgb(
	value: string,
): { r: number; g: number; b: number; alpha: number } | null {
	const match = value.match(
		/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i,
	);
	if (!match) return null;
	return {
		r: Number(match[1]),
		g: Number(match[2]),
		b: Number(match[3]),
		alpha: match[4] === undefined ? 1 : Number(match[4]),
	};
}

/**
 * The Bittery mark: a purple gradient key-shield with a subtle caret hinting
 * that clicking opens a list. Rendered inline (no network, no extra request)
 * and tinted for the surface it sits on.
 */
function renderIconMarkup(isDark: boolean): string {
	const idle = isDark ? "oklch(0.62 0.02 285)" : "oklch(0.55 0.02 285)";
	const hoverBg = isDark ? "oklch(1 0 0 / 0.09)" : "oklch(0 0 0 / 0.06)";
	const activeBg = isDark ? "oklch(1 0 0 / 0.14)" : "oklch(0 0 0 / 0.09)";

	return `
		<style>
			:host { all: initial; }
			.wrap {
				display: flex;
				align-items: center;
				justify-content: center;
				width: ${ICON_SIZE_PX}px;
				height: ${ICON_SIZE_PX}px;
				border-radius: 6px;
				cursor: pointer;
				color: ${idle};
				transition: background-color 120ms ease, color 120ms ease;
			}
			.wrap:hover {
				background-color: ${hoverBg};
				color: oklch(0.65 0.175 288);
			}
			.wrap:active { background-color: ${activeBg}; }
			svg { width: 15px; height: 15px; display: block; }
			.mark { fill: url(#bittery-mark); }
		</style>
		<div class="wrap" part="wrap">
			<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<defs>
					<linearGradient id="bittery-mark" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="oklch(0.7 0.165 288)" />
						<stop offset="100%" stop-color="oklch(0.58 0.185 292)" />
					</linearGradient>
				</defs>
				<path class="mark" d="M12 1.6 4.6 4.4v6.2c0 4.6 3 8.6 7.4 10.1 4.4-1.5 7.4-5.5 7.4-10.1V4.4L12 1.6Z" opacity="0.16" />
				<path class="mark" d="M12 1.6 4.6 4.4v6.2c0 4.6 3 8.6 7.4 10.1 4.4-1.5 7.4-5.5 7.4-10.1V4.4L12 1.6Zm0 1.9 5.5 2.1v5c0 3.6-2.2 6.8-5.5 8.1-3.3-1.3-5.5-4.5-5.5-8.1v-5L12 3.5Z" />
				<path class="mark" d="M12 7.2a2.4 2.4 0 0 0-1 4.6v3a1 1 0 0 0 2 0v-3a2.4 2.4 0 0 0-1-4.6Z" />
			</svg>
		</div>
	`;
}

export function showFieldIcon(
	field: AutofillField,
	hasItems: boolean,
	onToggle: (field: AutofillField) => void | Promise<void>,
) {
	hideFieldIcon(field);

	if (!hasItems && field.hasItems !== false) {
		return;
	}

	const input = field.input;

	const iconHost = document.createElement("div");
	iconHost.style.cssText = `
		position: fixed;
		width: ${ICON_SIZE_PX}px;
		height: ${ICON_SIZE_PX}px;
		z-index: 2147483646;
		pointer-events: auto;
		cursor: pointer;
	`;

	const shadow = iconHost.attachShadow({ mode: "open" });
	const container = document.createElement("div");
	container.innerHTML = renderIconMarkup(isOnDarkSurface(input));
	shadow.appendChild(container);

	document.body.appendChild(iconHost);
	field.icon = iconHost;

	iconHost.addEventListener("mousedown", (event) => {
		event.preventDefault();
		event.stopPropagation();
	});

	iconHost.addEventListener("click", async (event) => {
		event.preventDefault();
		event.stopPropagation();

		input.focus();
		await onToggle(field);
	});

	// Measured once; the tracker only re-applies the cached offset as the field
	// moves, so scrolling never triggers a `getComputedStyle` or sibling walk.
	const rightOffset = getInputRightOffset(input);

	const handle: AnchorHandle = trackAnchor({
		element: input,
		place: (rect) => {
			iconHost.style.left = `${rect.right - rightOffset}px`;
			iconHost.style.top = `${rect.top + (rect.height - ICON_SIZE_PX) / 2}px`;
		},
		onDetached: () => hideFieldIcon(field),
	});

	(iconHost as { _cleanup?: () => void })._cleanup = () => handle.release();
}

export function hideFieldIcon(field: AutofillField) {
	if (!field.icon) return;
	(field.icon as { _cleanup?: () => void })._cleanup?.();
	field.icon.remove();
	field.icon = undefined;
}
