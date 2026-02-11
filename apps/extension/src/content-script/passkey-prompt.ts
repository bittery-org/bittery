import type {
	PasskeyCreateSaveDecision,
	PasskeyUserInteractionRequest,
} from "../passkey/types";

const PASSKEY_PROMPT_WIDTH_PX = 380;
const PASSKEY_PROMPT_TIMEOUT_MS = 30_000;
const PASSKEY_PROMPT_REOPEN_NO_ANIMATION_WINDOW_MS = 600;

type PromptConfig<TDecision> = {
	requestId: string;
	iframePath: string;
	readyMessageType: string;
	payloadMessageType: string;
	payload: Record<string, unknown>;
	decisionMessageType: string;
	cancelMessageType: string;
	parseDecision: (value: unknown) => TDecision | null;
	timeoutMs?: number;
	signal?: AbortSignal;
};

type ActivePrompt = {
	requestId: string;
	finish: (
		value: unknown | null,
		options?: {
			animateClose?: boolean;
		},
	) => void;
};

let activePrompt: ActivePrompt | null = null;
let lastPromptClosedAt = 0;

function removePromptHost(
	shadowHost: HTMLElement,
	options?: { animate?: boolean },
): void {
	if (options?.animate === false) {
		shadowHost.remove();
		return;
	}

	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	window.setTimeout(() => {
		shadowHost.remove();
	}, 160);
}

function closeActivePrompt(
	nextValue: unknown | null,
	options?: { animateClose?: boolean },
): void {
	if (!activePrompt) {
		return;
	}
	activePrompt.finish(nextValue, options);
}

async function ensureDocumentBody(): Promise<void> {
	if (document.body) {
		return;
	}

	await new Promise<void>((resolve) => {
		document.addEventListener(
			"DOMContentLoaded",
			() => {
				resolve();
			},
			{ once: true },
		);
	});
}

async function showPrompt<TDecision>(
	config: PromptConfig<TDecision>,
): Promise<TDecision | null> {
	await ensureDocumentBody();
	closeActivePrompt(null, { animateClose: false });

	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.top = "20px";
	shadowHost.style.right = "20px";
	shadowHost.style.zIndex = "2147483647";
	shadowHost.style.width = `${PASSKEY_PROMPT_WIDTH_PX}px`;
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	const shadowRoot = shadowHost.attachShadow({ mode: "open" });
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "0px";
	iframe.style.minHeight = "56px";
	iframe.style.display = "block";
	// Keep the host iframe visually neutral so only the inner card surface is visible.
	iframe.style.borderRadius = "0";
	iframe.style.overflow = "visible";
	iframe.style.boxShadow = "none";
	iframe.style.background = "transparent";
	iframe.src = chrome.runtime.getURL(config.iframePath);
	shadowRoot.appendChild(iframe);

	const shouldSkipEnterAnimation =
		Date.now() - lastPromptClosedAt <
		PASSKEY_PROMPT_REOPEN_NO_ANIMATION_WINDOW_MS;
	if (shouldSkipEnterAnimation) {
		shadowHost.style.transition = "none";
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	} else {
		window.setTimeout(() => {
			shadowHost.style.opacity = "1";
			shadowHost.style.transform = "translateY(0)";
		}, 10);
	}

	return new Promise<TDecision | null>((resolve) => {
		let settled = false;
		let timeoutId = 0;

		const messageHandler = (event: MessageEvent) => {
			if (event.source !== iframe.contentWindow) {
				return;
			}
			if (!event.data || typeof event.data !== "object") {
				return;
			}

			const message = event.data as { type?: string; height?: number };
			if (message.type === config.readyMessageType) {
				iframe.contentWindow?.postMessage(
					{
						type: config.payloadMessageType,
						data: config.payload,
					},
					"*",
				);
				return;
			}
			if (
				message.type === "RESIZE_IFRAME" &&
				typeof message.height === "number"
			) {
				if (message.height > 0) {
					iframe.style.height = `${message.height}px`;
				}
				return;
			}
			if (message.type === config.cancelMessageType) {
				finish(null);
				return;
			}
			if (message.type === config.decisionMessageType) {
				const decision = config.parseDecision(event.data);
				finish(decision);
			}
		};

		const onAbort = () => {
			finish(null, { animateClose: false });
		};

		const finish = (
			value: TDecision | null,
			options?: {
				animateClose?: boolean;
			},
		) => {
			if (settled) {
				return;
			}
			settled = true;
			window.clearTimeout(timeoutId);
			window.removeEventListener("message", messageHandler);
			config.signal?.removeEventListener("abort", onAbort);
			if (
				activePrompt?.finish === (finish as (value: unknown | null) => void)
			) {
				activePrompt = null;
			}
			lastPromptClosedAt = Date.now();
			removePromptHost(shadowHost, {
				animate: options?.animateClose ?? true,
			});
			resolve(value);
		};

		window.addEventListener("message", messageHandler);
		if (config.signal) {
			if (config.signal.aborted) {
				finish(null);
				return;
			}
			config.signal.addEventListener("abort", onAbort, { once: true });
		}

		timeoutId = window.setTimeout(() => {
			finish(null);
		}, config.timeoutMs ?? PASSKEY_PROMPT_TIMEOUT_MS);

		activePrompt = {
			requestId: config.requestId,
			finish: finish as (value: unknown | null) => void,
		};

		// Fallback post for iframe load timing races.
		window.setTimeout(() => {
			iframe.contentWindow?.postMessage(
				{
					type: config.payloadMessageType,
					data: config.payload,
				},
				"*",
			);
		}, 120);
	});
}

function parseGetSelection(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const payload = value as { credentialId?: unknown };
	return typeof payload.credentialId === "string" &&
		payload.credentialId.length > 0
		? payload.credentialId
		: null;
}

function parseCreateDecision(value: unknown): PasskeyCreateSaveDecision | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const payload = value as { decision?: unknown };
	if (!payload.decision || typeof payload.decision !== "object") {
		return null;
	}
	const decision = payload.decision as {
		action?: unknown;
		itemId?: unknown;
		vaultId?: unknown;
	};
	if (
		decision.action === "attach-existing" &&
		typeof decision.itemId === "string"
	) {
		return {
			action: "attach-existing",
			itemId: decision.itemId,
		};
	}
	if (decision.action === "create-new") {
		return {
			action: "create-new",
			vaultId:
				typeof decision.vaultId === "string" ? decision.vaultId : undefined,
		};
	}
	return null;
}

export async function promptPasskeyGetSelection(input: {
	requestId: string;
	prompt: Extract<PasskeyUserInteractionRequest, { kind: "get-picker" }>;
	signal?: AbortSignal;
}): Promise<string | null> {
	return showPrompt<string>({
		requestId: input.requestId,
		iframePath: "passkey-picker-iframe.html",
		readyMessageType: "PASSKEY_PICKER_IFRAME_READY",
		payloadMessageType: "PASSKEY_PICKER_DATA",
		payload: input.prompt,
		decisionMessageType: "PASSKEY_PICKER_SELECT",
		cancelMessageType: "PASSKEY_PICKER_CANCEL",
		parseDecision: parseGetSelection,
		signal: input.signal,
	});
}

export async function promptPasskeyCreateDecision(input: {
	requestId: string;
	prompt: Extract<
		PasskeyUserInteractionRequest,
		{ kind: "create-save-target" }
	>;
	signal?: AbortSignal;
}): Promise<PasskeyCreateSaveDecision | null> {
	return showPrompt<PasskeyCreateSaveDecision>({
		requestId: input.requestId,
		iframePath: "passkey-save-target-iframe.html",
		readyMessageType: "PASSKEY_SAVE_TARGET_IFRAME_READY",
		payloadMessageType: "PASSKEY_SAVE_TARGET_DATA",
		payload: input.prompt,
		decisionMessageType: "PASSKEY_SAVE_TARGET_SUBMIT",
		cancelMessageType: "PASSKEY_SAVE_TARGET_CANCEL",
		parseDecision: parseCreateDecision,
		signal: input.signal,
	});
}

export function cancelPasskeyPrompt(requestId: string): void {
	if (!activePrompt || activePrompt.requestId !== requestId) {
		return;
	}
	closeActivePrompt(null);
}
