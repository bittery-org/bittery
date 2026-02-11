import {
	BITTERY_PASSKEY_CANCEL_REQUEST,
	BITTERY_PASSKEY_CREATE_REQUEST,
	BITTERY_PASSKEY_CREATE_RESPONSE,
	BITTERY_PASSKEY_GET_REQUEST,
	BITTERY_PASSKEY_GET_RESPONSE,
	BITTERY_PASSKEY_SOURCE_CONTENT,
	BITTERY_PASSKEY_SOURCE_PAGE,
	PASSKEY_BRIDGE_TIMEOUT_MS,
	isPasskeyPageRequestMessage,
	type PasskeyPageRequestMessage,
	type PasskeyPageResponseMessage,
} from "../passkey/types";

type ActiveRequest = {
	timeoutId: number;
};

const activeRequests = new Map<string, ActiveRequest>();
let bridgeInitialized = false;

function postResponse(message: PasskeyPageResponseMessage): void {
	window.postMessage(
		{
			source: BITTERY_PASSKEY_SOURCE_CONTENT,
			...message,
		},
		"*",
	);
}

function finalizeRequest(requestId: string): void {
	const activeRequest = activeRequests.get(requestId);
	if (!activeRequest) {
		return;
	}

	window.clearTimeout(activeRequest.timeoutId);
	activeRequests.delete(requestId);
}

function routeToBackground(
	message: PasskeyPageRequestMessage,
): Promise<Record<string, unknown>> {
	const runtimeType =
		message.type === BITTERY_PASSKEY_CREATE_REQUEST
			? "PASSKEY_CREATE"
			: message.type === BITTERY_PASSKEY_GET_REQUEST
				? "PASSKEY_GET"
				: "PASSKEY_CANCEL";

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		chrome.runtime.sendMessage(
			{
				type: runtimeType,
				payload: {
					requestId: message.requestId,
					...(message.type === BITTERY_PASSKEY_CANCEL_REQUEST
						? {}
						: message.payload),
				},
			},
			(response: Record<string, unknown>) => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
					return;
				}
				resolve(response ?? {});
			},
		);
	});
}

function isTrustedPageMessage(event: MessageEvent): boolean {
	if (event.source !== window) {
		return false;
	}
	if (event.origin !== window.location.origin) {
		return false;
	}
	if (!event.data || typeof event.data !== "object") {
		return false;
	}

	const source = (event.data as { source?: unknown }).source;
	return source === BITTERY_PASSKEY_SOURCE_PAGE;
}

async function handleRequest(message: PasskeyPageRequestMessage): Promise<void> {
	if (message.type === BITTERY_PASSKEY_CANCEL_REQUEST) {
		finalizeRequest(message.requestId);
		try {
			await routeToBackground(message);
		} catch (error) {
			console.debug("[Passkey bridge] cancel propagation failed:", error);
		}
		return;
	}

	if (activeRequests.has(message.requestId)) {
		return;
	}

	const timeoutId = window.setTimeout(() => {
		activeRequests.delete(message.requestId);
		postResponse({
			type:
				message.type === BITTERY_PASSKEY_CREATE_REQUEST
					? BITTERY_PASSKEY_CREATE_RESPONSE
					: BITTERY_PASSKEY_GET_RESPONSE,
			requestId: message.requestId,
			success: false,
			error: "Passkey bridge timeout",
			fallbackToNative: true,
		});
	}, PASSKEY_BRIDGE_TIMEOUT_MS);
	activeRequests.set(message.requestId, { timeoutId });

	try {
		const response = await routeToBackground(message);
		finalizeRequest(message.requestId);

		postResponse({
			type:
				message.type === BITTERY_PASSKEY_CREATE_REQUEST
					? BITTERY_PASSKEY_CREATE_RESPONSE
					: BITTERY_PASSKEY_GET_RESPONSE,
			requestId: message.requestId,
			success: Boolean(response.success),
			fallbackToNative: Boolean(response.fallbackToNative),
			error: typeof response.error === "string" ? response.error : undefined,
			result:
				typeof response.result === "object" && response.result
					? (response.result as PasskeyPageResponseMessage["result"])
					: undefined,
		});
	} catch (error) {
		finalizeRequest(message.requestId);
		postResponse({
			type:
				message.type === BITTERY_PASSKEY_CREATE_REQUEST
					? BITTERY_PASSKEY_CREATE_RESPONSE
					: BITTERY_PASSKEY_GET_RESPONSE,
			requestId: message.requestId,
			success: false,
			fallbackToNative: true,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function initPasskeyBridge(): void {
	if (bridgeInitialized) {
		return;
	}
	bridgeInitialized = true;

	window.addEventListener("message", (event) => {
		if (!isTrustedPageMessage(event)) {
			return;
		}

		if (!isPasskeyPageRequestMessage(event.data)) {
			return;
		}

		void handleRequest(event.data);
	});
}
