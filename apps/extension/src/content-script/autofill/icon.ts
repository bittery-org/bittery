import type { AutofillField } from "../types";

/**
 * Detect if the input has sibling elements (e.g. password show/hide toggle)
 * overlapping its right side, and return the appropriate right offset for the icon.
 */
function getInputRightOffset(input: HTMLInputElement): number {
	const BASE_OFFSET = 32;
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

export function showFieldIcon(
	field: AutofillField,
	hasItems: boolean,
	onToggle: (field: AutofillField) => void | Promise<void>,
) {
	if (field.icon) {
		field.icon.remove();
		field.icon = undefined;
	}

	if (!hasItems && field.hasItems !== false) {
		return;
	}

	const input = field.input;

	const iconHost = document.createElement("div");
	iconHost.style.cssText = `
		position: fixed;
		width: 24px;
		height: 24px;
		z-index: 2147483646;
		pointer-events: auto;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background-color 0.15s ease;
	`;

	const rect = input.getBoundingClientRect();
	const rightOffset = getInputRightOffset(input);
	iconHost.style.left = `${rect.right - rightOffset}px`;
	iconHost.style.top = `${rect.top + (rect.height - 24) / 2}px`;

	const shadow = iconHost.attachShadow({ mode: "open" });

	const iconContainer = document.createElement("div");
	iconContainer.innerHTML = `
		<style>
			:host {
				all: initial;
			}
			.icon-wrapper {
				display: flex;
				align-items: center;
				justify-content: center;
				width: 24px;
				height: 24px;
				border-radius: 4px;
				transition: background-color 0.15s ease;
				cursor: pointer;
			}
			.icon-wrapper:hover {
				background-color: rgba(0, 0, 0, 0.05);
			}
			.icon-svg {
				width: 18px;
				height: 18px;
				color: #6b7280;
			}
		</style>
		<div class="icon-wrapper">
			<svg class="icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
				<path d="M7 10L12 15L17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				<circle cx="18" cy="6" r="5" fill="white" stroke="currentColor" stroke-width="1.5"/>
				<path d="M18 4.5V7.5M16.5 6H19.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
			</svg>
		</div>
	`;

	shadow.appendChild(iconContainer);
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

	let rafId: number;
	let lastTop = rect.top;
	let lastRight = rect.right;
	let lastHeight = rect.height;

	const trackIconPosition = () => {
		if (!field.icon) return;
		if (!input.isConnected) {
			hideFieldIcon(field);
			return;
		}
		const nextRect = input.getBoundingClientRect();
		if (
			nextRect.top !== lastTop ||
			nextRect.right !== lastRight ||
			nextRect.height !== lastHeight
		) {
			lastTop = nextRect.top;
			lastRight = nextRect.right;
			lastHeight = nextRect.height;
			const offset = getInputRightOffset(input);
			iconHost.style.left = `${nextRect.right - offset}px`;
			iconHost.style.top = `${nextRect.top + (nextRect.height - 24) / 2}px`;
		}
		rafId = requestAnimationFrame(trackIconPosition);
	};
	rafId = requestAnimationFrame(trackIconPosition);

	(iconHost as { _cleanup?: () => void })._cleanup = () =>
		cancelAnimationFrame(rafId);
}

export function hideFieldIcon(field: AutofillField) {
	if (field.icon) {
		if ((field.icon as { _cleanup?: () => void })._cleanup) {
			(field.icon as { _cleanup?: () => void })._cleanup?.();
		}
		field.icon.remove();
		field.icon = undefined;
	}
}
