import type { DecryptedItem } from "@bittery/shared/types";
import type { AutofillField } from "../types";

// Visual feedback styles for autofilled fields
const AUTOFILL_HIGHLIGHT_STYLE = {
	boxShadow: "0 0 0 2px rgba(34, 197, 94, 0.5)",
	transition: "box-shadow 0.3s ease-out",
};
const AUTOFILL_SUCCESS_DURATION = 2000;

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
	timeoutLog: string;
	isAutofilling: () => boolean;
};

function createOverlayHost(field: AutofillField, minWidth = 300) {
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	const shadow = shadowHost.attachShadow({ mode: "open" });

	const positionOverlay = () => {
		const rect = field.input.getBoundingClientRect();
		shadowHost.style.top = `${rect.bottom}px`;
		shadowHost.style.left = `${rect.left}px`;
		shadowHost.style.width = `${Math.max(rect.width, minWidth)}px`;
	};
	positionOverlay();

	let overlayRafId: number;
	let lastBottom = field.input.getBoundingClientRect().bottom;
	let lastLeft = field.input.getBoundingClientRect().left;
	let lastWidth = field.input.getBoundingClientRect().width;
	const trackOverlayPosition = () => {
		if (!field.overlay || !field.input.isConnected) return;
		const rect = field.input.getBoundingClientRect();
		if (
			rect.bottom !== lastBottom ||
			rect.left !== lastLeft ||
			rect.width !== lastWidth
		) {
			lastBottom = rect.bottom;
			lastLeft = rect.left;
			lastWidth = rect.width;
			positionOverlay();
		}
		overlayRafId = requestAnimationFrame(trackOverlayPosition);
	};
	overlayRafId = requestAnimationFrame(trackOverlayPosition);
	field.repositionCleanup = () => cancelAnimationFrame(overlayRafId);

	return { shadowHost, shadow };
}

function createOverlayIframe(src: string) {
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "0px";
	iframe.style.maxHeight = "240px";
	iframe.style.display = "block";
	iframe.style.overflow = "hidden";
	iframe.style.background = "transparent";
	iframe.setAttribute("allowtransparency", "true");
	iframe.src = chrome.runtime.getURL(src);
	return iframe;
}

function animateOverlayIn(shadowHost: HTMLElement) {
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);
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
	timeoutLog,
	isAutofilling,
}: OverlayShowConfig<TField>) {
	if (field.overlay) {
		field.overlay.remove();
	}

	const { shadowHost, shadow } = createOverlayHost(field);
	const iframe = createOverlayIframe(iframeSrc);
	shadow.appendChild(iframe);

	field.overlay = shadowHost;
	setCurrentIframe(iframe);
	animateOverlayIn(shadowHost);

	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === readyMessageType) {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			iframe.contentWindow?.postMessage(
				{
					type: itemsMessageType,
					items,
					fieldType,
				},
				"*",
			);
		} else if (event.data.type === selectMessageType) {
			onSelect(field, event.data.item);
		} else if (event.data.type === "RESIZE_IFRAME" && event.data.height > 0) {
			iframe.style.height = `${event.data.height}px`;
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	field.readyTimeout = setTimeout(() => {
		console.log(timeoutLog);
		iframe.contentWindow?.postMessage(
			{
				type: itemsMessageType,
				items,
				fieldType,
			},
			"*",
		);
	}, 100);

	document.addEventListener("keydown", keyboardHandler, true);

	let filterTimeout: NodeJS.Timeout;
	const inputHandler = (event: Event) => {
		if (isAutofilling()) return;

		const input = event.target as HTMLInputElement;
		const query = input.value;

		clearTimeout(filterTimeout);
		filterTimeout = setTimeout(() => {
			iframe.contentWindow?.postMessage(
				{
					type: filterMessageType,
					query,
				},
				"*",
			);
		}, 150);
	};

	field.inputHandler = inputHandler;
	field.input.addEventListener("input", inputHandler);
}

export function hideItemsOverlay(
	field: AutofillField,
	options: {
		setCurrentIframe: () => void;
		keyboardHandler: (event: KeyboardEvent) => void;
	},
) {
	if (field.overlay) {
		field.overlay.remove();
		field.overlay = undefined;
	}

	options.setCurrentIframe();

	if (field.repositionCleanup) {
		field.repositionCleanup();
		field.repositionCleanup = undefined;
	}
	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
		field.messageHandler = undefined;
	}
	if (field.inputHandler) {
		field.input.removeEventListener("input", field.inputHandler);
		field.inputHandler = undefined;
	}
	if (field.readyTimeout) {
		clearTimeout(field.readyTimeout);
		field.readyTimeout = undefined;
	}

	document.removeEventListener("keydown", options.keyboardHandler, true);
}

export function showUnlockIframePrompt(
	field: AutofillField,
	options: {
		iframeSrc: string;
		readyMessageType: string;
	},
) {
	if (field.overlay) {
		field.overlay.remove();
	}

	const { shadowHost, shadow } = createOverlayHost(field);
	const iframe = createOverlayIframe(options.iframeSrc);
	shadow.appendChild(iframe);

	field.overlay = shadowHost;
	animateOverlayIn(shadowHost);

	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === options.readyMessageType) {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			iframe.contentWindow?.postMessage(
				{
					type: "NEEDS_UNLOCK",
				},
				"*",
			);
		} else if (event.data.type === "RESIZE_IFRAME" && event.data.height > 0) {
			iframe.style.height = `${event.data.height}px`;
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	field.readyTimeout = setTimeout(() => {
		iframe.contentWindow?.postMessage(
			{
				type: "NEEDS_UNLOCK",
			},
			"*",
		);
	}, 100);
}

export function showReauthPromptCard(field: AutofillField, subtitle: string) {
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	document.body.appendChild(shadowHost);

	const shadow = shadowHost.attachShadow({ mode: "open" });

	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 250)}px`;

	const container = document.createElement("div");
	container.style.cssText = `
		background: white;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
		padding: 12px;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 13px;
	`;

	container.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
			<span style="font-size: 16px;">🔒</span>
			<span style="font-weight: 500;">Authentication Required</span>
		</div>
		<p style="margin: 0 0 8px 0; color: #64748b; font-size: 12px;">
			${subtitle}
		</p>
		<button style="
			width: 100%;
			padding: 6px 12px;
			background: #3b82f6;
			color: white;
			border: none;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
		">
			Open Bittery
		</button>
	`;

	const button = container.querySelector("button");
	button?.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
		shadowHost.remove();
	});

	shadow.appendChild(container);
	field.overlay = shadowHost;

	setTimeout(() => {
		shadowHost.remove();
	}, 5000);
}

export function applyAutofillHighlight(input: HTMLInputElement) {
	const originalBoxShadow = input.style.boxShadow;
	const originalTransition = input.style.transition;

	input.style.boxShadow = AUTOFILL_HIGHLIGHT_STYLE.boxShadow;
	input.style.transition = AUTOFILL_HIGHLIGHT_STYLE.transition;

	input.setAttribute("data-bittery-autofilled", "true");

	setTimeout(() => {
		input.style.boxShadow = originalBoxShadow;
		input.style.transition = originalTransition;
		input.setAttribute("data-bittery-autofilled", "complete");
	}, AUTOFILL_SUCCESS_DURATION);
}
