import type { DecryptedItem } from "@bittery/shared/types";
import {
	createAutofillSelectSchema,
	openPopupMessageSchema,
	resizeIframeMessageSchema,
	unlockDesktopMessageSchema,
	validateIframeMessage,
} from "../iframe-messages";
import type { AutofillField } from "../types";
import { type AnchorHandle, trackAnchor } from "./anchor-position";
import { acquireOverlay, type PooledOverlay, peekOverlay } from "./iframe-pool";

/**
 * The iframe is sized exactly to the card — no gutter. The drop shadow is drawn
 * by the host element (see `overlay-chrome`), so nothing needs to paint outside
 * the frame, and no band of transparent-but-clickable iframe covers the page.
 */
const OVERLAY_GAP_PX = 6;
const OVERLAY_MIN_WIDTH_PX = 300;
/** Below this much room under the field, the dropdown flips above it. */
const FLIP_MARGIN_PX = 24;

const FILTER_DEBOUNCE_MS = 90;

/** Live geometry per field, so a resize can re-run the flip decision. */
interface OverlayAnchorState {
	handle: AnchorHandle | null;
	height: number;
}
const anchorState = new WeakMap<HTMLElement, OverlayAnchorState>();

export type OverlayShowConfig<TField extends AutofillField> = {
	field: TField;
	items: DecryptedItem[];
	iframeSrc: string;
	readyMessageType: string;
	selectMessageType: string;
	itemsMessageType: string;
	filterMessageType: string;
	fieldType: string;
	onSelect: (field: TField, item: DecryptedItem) => void | Promise<void>;
	setCurrentIframe: (iframe: HTMLIFrameElement | null) => void;
	keyboardHandler: (event: KeyboardEvent) => void;
	isAutofilling: () => boolean;
};

/**
 * Place the host under (or above) the anchor. Reads nothing — `rect` is supplied
 * by the shared positioner, which batches all reads before any writes.
 */
function placeOverlay(host: HTMLElement, rect: DOMRect, height: number): void {
	host.style.left = `${rect.left}px`;
	host.style.width = `${Math.max(rect.width, OVERLAY_MIN_WIDTH_PX)}px`;

	const roomBelow = window.innerHeight - rect.bottom - OVERLAY_GAP_PX;
	const shouldFlip =
		height > 0 &&
		roomBelow < height + FLIP_MARGIN_PX &&
		rect.top > height + OVERLAY_GAP_PX;

	host.style.top = shouldFlip
		? `${rect.top - height - OVERLAY_GAP_PX}px`
		: `${rect.bottom + OVERLAY_GAP_PX}px`;
}

function attachOverlayToField(
	field: AutofillField,
	overlay: PooledOverlay,
): void {
	const state = { handle: null as AnchorHandle | null, height: 0 };

	state.handle = trackAnchor({
		element: field.input,
		place: (rect) => placeOverlay(overlay.host, rect, state.height),
		onDetached: () => {
			overlay.hide();
			field.overlay = undefined;
		},
	});

	anchorState.set(field.input, state);

	field.repositionCleanup = () => {
		state.handle?.release();
		anchorState.delete(field.input);
	};
	field.overlay = overlay.host;
	overlay.show();
}

/** Record the frame's reported height and re-run the above/below decision. */
function setOverlayHeight(field: AutofillField, height: number): void {
	const state = anchorState.get(field.input);
	if (!state || state.height === height) return;
	state.height = height;
	state.handle?.refresh();
}

export function showItemsOverlay<TField extends AutofillField>({
	field,
	items,
	iframeSrc,
	readyMessageType,
	selectMessageType,
	itemsMessageType,
	filterMessageType,
	fieldType,
	onSelect,
	setCurrentIframe,
	keyboardHandler,
	isAutofilling,
}: OverlayShowConfig<TField>) {
	const overlay = acquireOverlay(iframeSrc, readyMessageType);

	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
	}
	field.repositionCleanup?.();

	const messageHandler = (event: MessageEvent) => {
		const expected = {
			expectedSource: overlay.iframe.contentWindow,
			expectedOrigin: overlay.origin,
			expectedNonce: overlay.nonce,
		};

		const selectMessage = validateIframeMessage(event, {
			...expected,
			schema: createAutofillSelectSchema(selectMessageType),
		});
		if (selectMessage) {
			onSelect(field, selectMessage.item as DecryptedItem);
			return;
		}

		const resizeMessage = validateIframeMessage(event, {
			...expected,
			schema: resizeIframeMessageSchema,
		});
		if (resizeMessage) {
			overlay.setHeight(resizeMessage.height);
			setOverlayHeight(field, resizeMessage.height);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Queued transparently when the frame is still booting; instant on reuse.
	overlay.post({ type: itemsMessageType, items, fieldType });

	setCurrentIframe(overlay.iframe);
	attachOverlayToField(field, overlay);

	document.addEventListener("keydown", keyboardHandler, true);

	let filterTimeout: ReturnType<typeof setTimeout>;
	const inputHandler = (event: Event) => {
		if (isAutofilling()) return;
		const query = (event.target as HTMLInputElement).value;

		clearTimeout(filterTimeout);
		filterTimeout = setTimeout(() => {
			overlay.post({ type: filterMessageType, query });
		}, FILTER_DEBOUNCE_MS);
	};

	field.inputHandler = inputHandler;
	field.input.addEventListener("input", inputHandler);
}

export function hideItemsOverlay(
	field: AutofillField,
	options: {
		iframeSrc: string;
		setCurrentIframe: () => void;
		keyboardHandler: (event: KeyboardEvent) => void;
	},
) {
	if (field.overlay) {
		peekOverlay(options.iframeSrc)?.hide();
		field.overlay = undefined;
	}

	options.setCurrentIframe();

	field.repositionCleanup?.();
	field.repositionCleanup = undefined;

	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
		field.messageHandler = undefined;
	}
	if (field.inputHandler) {
		field.input.removeEventListener("input", field.inputHandler);
		field.inputHandler = undefined;
	}

	document.removeEventListener("keydown", options.keyboardHandler, true);
}

/**
 * Show the locked / re-authentication state of an overlay document.
 *
 * These used to be two different things: an iframe for "locked" and a slab of
 * hand-written English HTML for "needs re-auth". Both are now states of the same
 * themed, translated overlay.
 *
 * `NEEDS_DESKTOP_UNLOCK` is the case where a connected desktop app is what's
 * holding the lock. Opening the popup there is a dead end — it can only offer to
 * unlock the desktop anyway — so that state asks the desktop directly.
 */
export function showAuthStateOverlay(
	field: AutofillField,
	options: {
		iframeSrc: string;
		readyMessageType: string;
		state: "NEEDS_UNLOCK" | "NEEDS_REAUTH" | "NEEDS_DESKTOP_UNLOCK";
	},
) {
	const overlay = acquireOverlay(options.iframeSrc, options.readyMessageType);

	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
	}
	field.repositionCleanup?.();

	const messageHandler = (event: MessageEvent) => {
		const expected = {
			expectedSource: overlay.iframe.contentWindow,
			expectedOrigin: overlay.origin,
			expectedNonce: overlay.nonce,
		};

		if (
			validateIframeMessage(event, {
				...expected,
				schema: openPopupMessageSchema,
			})
		) {
			chrome.runtime.sendMessage({ type: "OPEN_POPUP" }).catch(() => {
				// The popup can only be opened programmatically on newer Chrome
				// builds; the toolbar icon remains the fallback either way.
			});
			overlay.hide();
			field.overlay = undefined;
			return;
		}

		if (
			validateIframeMessage(event, {
				...expected,
				schema: unlockDesktopMessageSchema,
			})
		) {
			chrome.runtime
				.sendMessage({ type: "TRIGGER_DESKTOP_UNLOCK" })
				.catch(() => {
					// Desktop went away between the status read and the click; the
					// overlay re-checks on the next focus either way.
				});
			overlay.hide();
			field.overlay = undefined;
			return;
		}

		const resizeMessage = validateIframeMessage(event, {
			...expected,
			schema: resizeIframeMessageSchema,
		});
		if (resizeMessage) {
			overlay.setHeight(resizeMessage.height);
			setOverlayHeight(field, resizeMessage.height);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	overlay.post({ type: options.state });
	attachOverlayToField(field, overlay);
}

/**
 * Flash a field that was just filled. Uses the brand purple rather than a raw
 * green so it reads as "Bittery did this", and derives both the ring and its
 * glow from `--color-primary` so it works on light and dark pages alike.
 */
const AUTOFILL_SUCCESS_DURATION = 1600;

export function applyAutofillHighlight(input: HTMLInputElement) {
	const originalBoxShadow = input.style.boxShadow;
	const originalTransition = input.style.transition;

	input.style.boxShadow =
		"0 0 0 2px color-mix(in oklab, oklch(0.7 0.165 288) 55%, transparent), 0 0 12px color-mix(in oklab, oklch(0.7 0.165 288) 35%, transparent)";
	input.style.transition = "box-shadow 0.3s ease-out";
	input.setAttribute("data-bittery-autofilled", "true");

	setTimeout(() => {
		input.style.boxShadow = originalBoxShadow;
		input.style.transition = originalTransition;
		input.setAttribute("data-bittery-autofilled", "complete");
	}, AUTOFILL_SUCCESS_DURATION);
}
