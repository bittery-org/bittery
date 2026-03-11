import {
	BITTERY_PASSKEY_CANCEL_REQUEST,
	BITTERY_PASSKEY_CREATE_REQUEST,
	BITTERY_PASSKEY_CREATE_RESPONSE,
	BITTERY_PASSKEY_GET_REQUEST,
	BITTERY_PASSKEY_GET_RESPONSE,
	BITTERY_PASSKEY_SOURCE_CONTENT,
	BITTERY_PASSKEY_SOURCE_PAGE,
	isPasskeyPageRequestMessage,
	PASSKEY_BRIDGE_TIMEOUT_MS,
	type PasskeyBackgroundResponse,
	type PasskeyCreateHandlerPayload,
	type PasskeyGetHandlerPayload,
	type PasskeyPageRequestMessage,
	type PasskeyPageResponseMessage,
} from "../passkey/types";
import {
	cancelPasskeyPrompt,
	promptPasskeyCreateDecision,
	promptPasskeyGetSelection,
} from "./passkey-prompt";

type ActiveRequest = {
	timeoutId: number;
	abortController: AbortController;
	responseType:
		| typeof BITTERY_PASSKEY_CREATE_RESPONSE
		| typeof BITTERY_PASSKEY_GET_RESPONSE;
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

function responseTypeForMessage(
	type:
		| typeof BITTERY_PASSKEY_CREATE_REQUEST
		| typeof BITTERY_PASSKEY_GET_REQUEST
		| typeof BITTERY_PASSKEY_CANCEL_REQUEST,
):
	| typeof BITTERY_PASSKEY_CREATE_RESPONSE
	| typeof BITTERY_PASSKEY_GET_RESPONSE {
	return type === BITTERY_PASSKEY_CREATE_REQUEST
		? BITTERY_PASSKEY_CREATE_RESPONSE
		: BITTERY_PASSKEY_GET_RESPONSE;
}

function cancelRequest(requestId: string): ActiveRequest | undefined {
	const activeRequest = activeRequests.get(requestId);
	if (!activeRequest) {
		return undefined;
	}

	window.clearTimeout(activeRequest.timeoutId);
	activeRequest.abortController.abort();
	activeRequests.delete(requestId);
	cancelPasskeyPrompt(requestId);
	return activeRequest;
}

function postSerializedResponse(input: {
	requestId: string;
	responseType:
		| typeof BITTERY_PASSKEY_CREATE_RESPONSE
		| typeof BITTERY_PASSKEY_GET_RESPONSE;
	response: PasskeyBackgroundResponse;
}): void {
	postResponse({
		type: input.responseType,
		requestId: input.requestId,
		success: Boolean(input.response.success),
		fallbackToNative: Boolean(input.response.fallbackToNative),
		error:
			typeof input.response.error === "string"
				? input.response.error
				: undefined,
		result:
			typeof input.response.result === "object" && input.response.result
				? (input.response.result as PasskeyPageResponseMessage["result"])
				: undefined,
	});
}

function sendRuntimeMessage(
	runtimeType: "PASSKEY_CREATE" | "PASSKEY_GET" | "PASSKEY_CANCEL",
	payload: Record<string, unknown>,
): Promise<PasskeyBackgroundResponse> {
	return new Promise<PasskeyBackgroundResponse>((resolve, reject) => {
		chrome.runtime.sendMessage(
			{
				type: runtimeType,
				payload,
			},
			(response: PasskeyBackgroundResponse) => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
					return;
				}
				resolve(response ?? { success: false, fallbackToNative: true });
			},
		);
	});
}

async function executePasskeyFlow(input: {
	message:
		| Extract<
				PasskeyPageRequestMessage,
				{ type: typeof BITTERY_PASSKEY_CREATE_REQUEST }
		  >
		| Extract<
				PasskeyPageRequestMessage,
				{ type: typeof BITTERY_PASSKEY_GET_REQUEST }
		  >;
	signal: AbortSignal;
}): Promise<PasskeyBackgroundResponse> {
	const runtimeType =
		input.message.type === BITTERY_PASSKEY_CREATE_REQUEST
			? "PASSKEY_CREATE"
			: "PASSKEY_GET";

	console.info("[Passkey bridge] forwarding request", {
		requestId: input.message.requestId,
		runtimeType,
		origin: input.message.payload.origin,
		mediation: input.message.payload.mediation,
	});

	let response = await sendRuntimeMessage(runtimeType, {
		requestId: input.message.requestId,
		...input.message.payload,
	});

	console.info("[Passkey bridge] runtime response received", {
		requestId: input.message.requestId,
		runtimeType,
		success: response.success,
		fallbackToNative: response.fallbackToNative,
		error: response.error,
		requiresUserInteraction: response.requiresUserInteraction?.kind,
		resultKind: response.result?.kind,
	});

	for (let attempts = 0; attempts < 3; attempts++) {
		if (!response.requiresUserInteraction) {
			return response;
		}

		if (input.signal.aborted) {
			return {
				success: false,
				fallbackToNative: true,
				error: "Passkey request cancelled",
			};
		}

		if (
			response.requiresUserInteraction.kind === "get-picker" &&
			input.message.type === BITTERY_PASSKEY_GET_REQUEST
		) {
			const selectedCredentialId = await promptPasskeyGetSelection({
				requestId: input.message.requestId,
				prompt: response.requiresUserInteraction,
				signal: input.signal,
			});
			if (!selectedCredentialId) {
				return {
					success: false,
					fallbackToNative: true,
					error: "Passkey request cancelled",
				};
			}

			const payload: PasskeyGetHandlerPayload = {
				requestId: input.message.requestId,
				...input.message.payload,
				selectedCredentialId,
			};
			response = await sendRuntimeMessage("PASSKEY_GET", payload);
			console.info("[Passkey bridge] runtime response after picker", {
				requestId: input.message.requestId,
				success: response.success,
				fallbackToNative: response.fallbackToNative,
				error: response.error,
				requiresUserInteraction: response.requiresUserInteraction?.kind,
				resultKind: response.result?.kind,
			});
			continue;
		}

		if (
			response.requiresUserInteraction.kind === "create-save-target" &&
			input.message.type === BITTERY_PASSKEY_CREATE_REQUEST
		) {
			const createDecision = await promptPasskeyCreateDecision({
				requestId: input.message.requestId,
				prompt: response.requiresUserInteraction,
				signal: input.signal,
			});
			if (!createDecision) {
				return {
					success: false,
					fallbackToNative: true,
					error: "Passkey request cancelled",
				};
			}

			const payload: PasskeyCreateHandlerPayload = {
				requestId: input.message.requestId,
				...input.message.payload,
				createDecision,
			};
			response = await sendRuntimeMessage("PASSKEY_CREATE", payload);
			console.info("[Passkey bridge] runtime response after create decision", {
				requestId: input.message.requestId,
				success: response.success,
				fallbackToNative: response.fallbackToNative,
				error: response.error,
				requiresUserInteraction: response.requiresUserInteraction?.kind,
				resultKind: response.result?.kind,
			});
			continue;
		}

		return {
			success: false,
			fallbackToNative: true,
			error: "Invalid passkey interaction state",
		};
	}

	return {
		success: false,
		fallbackToNative: true,
		error: "Passkey interaction did not resolve",
	};
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

async function handleRequest(
	message: PasskeyPageRequestMessage,
): Promise<void> {
	if (message.type === BITTERY_PASSKEY_CANCEL_REQUEST) {
		const cancelledRequest = cancelRequest(message.requestId);
		if (cancelledRequest) {
			postResponse({
				type: cancelledRequest.responseType,
				requestId: message.requestId,
				success: false,
				fallbackToNative: true,
				error: "Passkey request cancelled",
			});
		}
		try {
			await sendRuntimeMessage("PASSKEY_CANCEL", {
				requestId: message.requestId,
			});
		} catch (error) {
			console.debug("[Passkey bridge] cancel propagation failed:", error);
		}
		return;
	}

	if (activeRequests.has(message.requestId)) {
		return;
	}

	const responseType = responseTypeForMessage(message.type);
	const abortController = new AbortController();
	const timeoutId = window.setTimeout(() => {
		cancelRequest(message.requestId);
		postResponse({
			type: responseType,
			requestId: message.requestId,
			success: false,
			error: "Passkey bridge timeout",
			fallbackToNative: true,
		});
	}, PASSKEY_BRIDGE_TIMEOUT_MS);
	activeRequests.set(message.requestId, {
		timeoutId,
		abortController,
		responseType,
	});

	try {
		const response = await executePasskeyFlow({
			message,
			signal: abortController.signal,
		});
		if (!activeRequests.has(message.requestId)) {
			return;
		}
		finalizeRequest(message.requestId);
		postSerializedResponse({
			requestId: message.requestId,
			responseType,
			response,
		});
	} catch (error) {
		if (!activeRequests.has(message.requestId)) {
			return;
		}
		finalizeRequest(message.requestId);
		postResponse({
			type: responseType,
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
