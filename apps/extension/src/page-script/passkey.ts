import {
	arrayBufferToBase64Url,
	base64UrlToBytes,
	bytesToBase64Url,
} from "../passkey/base64";
import {
	BITTERY_PASSKEY_CANCEL_REQUEST,
	BITTERY_PASSKEY_CREATE_REQUEST,
	BITTERY_PASSKEY_CREATE_RESPONSE,
	BITTERY_PASSKEY_GET_REQUEST,
	BITTERY_PASSKEY_GET_RESPONSE,
	BITTERY_PASSKEY_SOURCE_CONTENT,
	BITTERY_PASSKEY_SOURCE_PAGE,
	type PasskeyPageCreatePayload,
	type PasskeyPageGetPayload,
	type PasskeyPageResponseMessage,
	type SerializedCreateResult,
	type SerializedCreationOptions,
	type SerializedCredentialDescriptor,
	type SerializedGetResult,
	type SerializedRequestOptions,
} from "../passkey/types";

type PendingRequest = {
	resolve: (response: PasskeyPageResponseMessage) => void;
	reject: (error: Error) => void;
	timeoutId: number;
};

const pendingRequests = new Map<string, PendingRequest>();

const createNative = navigator.credentials?.create?.bind(navigator.credentials);
const getNative = navigator.credentials?.get?.bind(navigator.credentials);
const installFlag = "__bitteryPasskeyInterceptorInstalled";
const PASSKEY_TRANSIENT_GET_STABILIZE_MS = 550;

function isTopFrame(): boolean {
	try {
		return window.top === window;
	} catch {
		return false;
	}
}

function randomRequestId(): string {
	return `req_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function toUint8Array(buffer: BufferSource): Uint8Array {
	if (buffer instanceof Uint8Array) {
		return buffer;
	}
	if (buffer instanceof ArrayBuffer) {
		return new Uint8Array(buffer);
	}
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
	const buffer = new ArrayBuffer(data.byteLength);
	new Uint8Array(buffer).set(data);
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return new Uint8Array(digest);
}

function buildClientDataJson(
	type: "webauthn.create" | "webauthn.get",
	challengeBase64Url: string,
): Uint8Array {
	const payload = {
		type,
		challenge: challengeBase64Url,
		origin: window.location.origin,
		crossOrigin: false,
	};

	return new TextEncoder().encode(JSON.stringify(payload));
}

function serializeDescriptor(
	descriptor: PublicKeyCredentialDescriptor,
): SerializedCredentialDescriptor {
	return {
		type: descriptor.type,
		id: arrayBufferToBase64Url(toUint8Array(descriptor.id)),
		transports: descriptor.transports,
	};
}

function serializeCreateOptions(
	publicKey: PublicKeyCredentialCreationOptions,
): SerializedCreationOptions | null {
	if (
		!publicKey.rp?.name ||
		!publicKey.user?.name ||
		!publicKey.user?.displayName
	) {
		return null;
	}

	return {
		rp: {
			id: publicKey.rp.id,
			name: publicKey.rp.name,
		},
		user: {
			id: arrayBufferToBase64Url(toUint8Array(publicKey.user.id)),
			name: publicKey.user.name,
			displayName: publicKey.user.displayName,
		},
		challenge: arrayBufferToBase64Url(toUint8Array(publicKey.challenge)),
		pubKeyCredParams: publicKey.pubKeyCredParams,
		timeout: publicKey.timeout,
		excludeCredentials: publicKey.excludeCredentials?.map(serializeDescriptor),
		authenticatorSelection: publicKey.authenticatorSelection,
		attestation: publicKey.attestation,
	};
}

function serializeGetOptions(
	publicKey: PublicKeyCredentialRequestOptions,
): SerializedRequestOptions {
	return {
		challenge: arrayBufferToBase64Url(toUint8Array(publicKey.challenge)),
		rpId: publicKey.rpId,
		timeout: publicKey.timeout,
		allowCredentials: publicKey.allowCredentials?.map(serializeDescriptor),
		userVerification: publicKey.userVerification,
	};
}

function postPageMessage(message: object): void {
	window.postMessage(
		{
			source: BITTERY_PASSKEY_SOURCE_PAGE,
			...message,
		},
		"*",
	);
}

function sendBridgeRequest(input: {
	type:
		| typeof BITTERY_PASSKEY_CREATE_REQUEST
		| typeof BITTERY_PASSKEY_GET_REQUEST;
	payload: PasskeyPageCreatePayload | PasskeyPageGetPayload;
	timeoutMs?: number;
}): { requestId: string; promise: Promise<PasskeyPageResponseMessage> } {
	const requestId = randomRequestId();
	const timeoutMs = Math.max(500, input.timeoutMs ?? 15_000);

	const promise = new Promise<PasskeyPageResponseMessage>((resolve, reject) => {
		const timeoutId = window.setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error("Passkey bridge timed out"));
		}, timeoutMs);

		pendingRequests.set(requestId, {
			resolve,
			reject,
			timeoutId,
		});

		postPageMessage({
			type: input.type,
			requestId,
			payload: input.payload,
		});
	});

	return { requestId, promise };
}

function attachAbortRelay(
	signal: AbortSignal | null | undefined,
	requestId: string,
): (() => void) | null {
	if (!signal) {
		return null;
	}

	const onAbort = () => {
		postPageMessage({
			type: BITTERY_PASSKEY_CANCEL_REQUEST,
			requestId,
		});
	};

	signal.addEventListener("abort", onAbort, { once: true });
	return () => {
		signal.removeEventListener("abort", onAbort);
	};
}

function waitForAbortOrTimeout(
	signal: AbortSignal | null | undefined,
	timeoutMs: number,
): Promise<boolean> {
	if (!signal) {
		return Promise.resolve(true);
	}
	if (signal.aborted) {
		return Promise.resolve(false);
	}

	return new Promise<boolean>((resolve) => {
		const onAbort = () => {
			window.clearTimeout(timeoutId);
			resolve(false);
		};
		const timeoutId = window.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, timeoutMs);

		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function finalizePendingResponse(response: PasskeyPageResponseMessage): void {
	const pending = pendingRequests.get(response.requestId);
	if (!pending) {
		return;
	}

	pendingRequests.delete(response.requestId);
	window.clearTimeout(pending.timeoutId);
	pending.resolve(response);
}

function handleBridgeMessage(event: MessageEvent): void {
	if (
		event.source !== window ||
		!event.data ||
		typeof event.data !== "object"
	) {
		return;
	}

	const message = event.data as Partial<PasskeyPageResponseMessage> & {
		source?: string;
	};
	if (message.source !== BITTERY_PASSKEY_SOURCE_CONTENT) {
		return;
	}
	if (
		message.type !== BITTERY_PASSKEY_CREATE_RESPONSE &&
		message.type !== BITTERY_PASSKEY_GET_RESPONSE
	) {
		return;
	}
	if (typeof message.requestId !== "string") {
		return;
	}

	finalizePendingResponse(message as PasskeyPageResponseMessage);
}

function buildCreateCredential(
	result: SerializedCreateResult,
): PublicKeyCredential {
	const response = {
		clientDataJSON: base64UrlToBytes(result.response.clientDataJSON).buffer,
		attestationObject: base64UrlToBytes(result.response.attestationObject)
			.buffer,
		getPublicKeyAlgorithm: () => -7,
		getPublicKey: () => null,
		getAuthenticatorData: () => null,
		getTransports: () => ["internal", "hybrid"] as AuthenticatorTransport[],
	};
	Object.setPrototypeOf(response, AuthenticatorAttestationResponse.prototype);

	const credential = {
		id: result.id,
		rawId: base64UrlToBytes(result.rawId).buffer,
		type: result.type,
		response,
		authenticatorAttachment: result.authenticatorAttachment,
		getClientExtensionResults: () => ({}),
		toJSON: () => ({
			id: result.id,
			rawId: result.rawId,
			type: result.type,
			response: {
				clientDataJSON: result.response.clientDataJSON,
				attestationObject: result.response.attestationObject,
			},
		}),
	};
	Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
	return credential as unknown as PublicKeyCredential;
}

function buildAssertionCredential(
	result: SerializedGetResult,
): PublicKeyCredential {
	const response = {
		clientDataJSON: base64UrlToBytes(result.response.clientDataJSON).buffer,
		authenticatorData: base64UrlToBytes(result.response.authenticatorData)
			.buffer,
		signature: base64UrlToBytes(result.response.signature).buffer,
		userHandle: result.response.userHandle
			? base64UrlToBytes(result.response.userHandle).buffer
			: null,
	};
	Object.setPrototypeOf(response, AuthenticatorAssertionResponse.prototype);

	const credential = {
		id: result.id,
		rawId: base64UrlToBytes(result.rawId).buffer,
		type: result.type,
		response,
		authenticatorAttachment: result.authenticatorAttachment,
		getClientExtensionResults: () => ({}),
		toJSON: () => ({
			id: result.id,
			rawId: result.rawId,
			type: result.type,
			response: {
				clientDataJSON: result.response.clientDataJSON,
				authenticatorData: result.response.authenticatorData,
				signature: result.response.signature,
				userHandle: result.response.userHandle,
			},
		}),
	};
	Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
	return credential as unknown as PublicKeyCredential;
}

function supportsEs256(params: PublicKeyCredentialParameters[]): boolean {
	return params.some(
		(param) => param.type === "public-key" && param.alg === -7,
	);
}

async function interceptCreate(
	options?: CredentialCreationOptions,
): Promise<Credential | null> {
	if (!createNative || !options?.publicKey) {
		return createNative?.(options) ?? null;
	}

	const publicKey = options.publicKey;
	if (!supportsEs256(publicKey.pubKeyCredParams)) {
		return createNative(options);
	}

	const serializedOptions = serializeCreateOptions(publicKey);
	if (!serializedOptions) {
		return createNative(options);
	}
	const signal = (
		options as CredentialCreationOptions & { signal?: AbortSignal }
	).signal;
	if (signal?.aborted) {
		return createNative(options);
	}

	const clientDataJsonBytes = buildClientDataJson(
		"webauthn.create",
		serializedOptions.challenge,
	);
	const clientDataHash = await sha256(clientDataJsonBytes);

	const payload: PasskeyPageCreatePayload = {
		origin: window.location.origin,
		mediation: (
			options as CredentialCreationOptions & {
				mediation?: CredentialMediationRequirement;
			}
		).mediation,
		publicKey: serializedOptions,
		clientDataJSON: bytesToBase64Url(clientDataJsonBytes),
		clientDataHash: bytesToBase64Url(clientDataHash),
	};

	const request = sendBridgeRequest({
		type: BITTERY_PASSKEY_CREATE_REQUEST,
		payload,
		timeoutMs: publicKey.timeout,
	});

	const detachAbort = attachAbortRelay(signal, request.requestId);

	try {
		const response = await request.promise;
		if (response.fallbackToNative || !response.success || !response.result) {
			if (!response.success && response.error) {
				throw new Error(response.error);
			}
			return createNative(options);
		}
		if (response.result.kind !== "create") {
			return createNative(options);
		}
		return buildCreateCredential(response.result);
	} catch (error) {
		console.warn(
			"[Bittery Passkey] create interception failed, using native:",
			error,
		);
		return createNative(options);
	} finally {
		detachAbort?.();
	}
}

async function interceptGet(
	options?: CredentialRequestOptions,
): Promise<Credential | null> {
	if (!getNative || !options?.publicKey) {
		return getNative?.(options) ?? null;
	}

	const publicKey = options.publicKey;
	const mediation = (
		options as CredentialRequestOptions & {
			mediation?: CredentialMediationRequirement;
		}
	).mediation;
	const signal = (
		options as CredentialRequestOptions & { signal?: AbortSignal }
	).signal;
	if (mediation === "conditional" || mediation === "silent") {
		// Conditional/silent requests can be quickly aborted/restarted by sites.
		// Wait briefly so we skip cancelled attempts and only show a stable prompt.
		const isStableRequest = await waitForAbortOrTimeout(
			signal,
			PASSKEY_TRANSIENT_GET_STABILIZE_MS,
		);
		if (!isStableRequest) {
			return getNative(options);
		}
	}
	if (signal?.aborted) {
		return getNative(options);
	}
	const serializedOptions = serializeGetOptions(publicKey);
	const clientDataJsonBytes = buildClientDataJson(
		"webauthn.get",
		serializedOptions.challenge,
	);
	const clientDataHash = await sha256(clientDataJsonBytes);

	const payload: PasskeyPageGetPayload = {
		origin: window.location.origin,
		mediation,
		publicKey: serializedOptions,
		clientDataJSON: bytesToBase64Url(clientDataJsonBytes),
		clientDataHash: bytesToBase64Url(clientDataHash),
	};

	const request = sendBridgeRequest({
		type: BITTERY_PASSKEY_GET_REQUEST,
		payload,
		timeoutMs: publicKey.timeout,
	});

	console.info("[Bittery Passkey] get intercepted", {
		requestId: request.requestId,
		href: window.location.href,
		origin: window.location.origin,
		isTopFrame: isTopFrame(),
		mediation,
		rpId: serializedOptions.rpId,
		allowCredentialsCount: serializedOptions.allowCredentials?.length ?? 0,
	});

	const detachAbort = attachAbortRelay(signal, request.requestId);

	try {
		const response = await request.promise;
		if (response.fallbackToNative || !response.success || !response.result) {
			console.warn("[Bittery Passkey] get bridge falling back to native", {
				requestId: request.requestId,
				href: window.location.href,
				origin: window.location.origin,
				isTopFrame: isTopFrame(),
				mediation,
				rpId: serializedOptions.rpId,
				allowCredentialsCount: serializedOptions.allowCredentials?.length ?? 0,
				success: response.success,
				fallbackToNative: response.fallbackToNative,
				error: response.error,
				resultKind: response.result?.kind,
			});
			if (!response.success && response.error) {
				throw new Error(response.error);
			}
			return getNative(options);
		}
		if (response.result.kind !== "get") {
			return getNative(options);
		}
		return buildAssertionCredential(response.result);
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		console.warn("[Bittery Passkey] get interception failed, using native", {
			requestId: request.requestId,
			href: window.location.href,
			origin: window.location.origin,
			isTopFrame: isTopFrame(),
			mediation,
			rpId: serializedOptions.rpId,
			allowCredentialsCount: serializedOptions.allowCredentials?.length ?? 0,
			error: error instanceof Error ? error.message : String(error),
		});
		return getNative(options);
	} finally {
		detachAbort?.();
	}
}

function installPasskeyInterceptors(): void {
	if (!navigator.credentials || !createNative || !getNative) {
		return;
	}

	const globalWindow = window as unknown as Window & Record<string, unknown>;
	if (globalWindow[installFlag]) {
		return;
	}
	globalWindow[installFlag] = true;

	window.addEventListener("message", handleBridgeMessage, false);

	try {
		Object.defineProperty(navigator.credentials, "create", {
			configurable: true,
			value: interceptCreate,
		});
		Object.defineProperty(navigator.credentials, "get", {
			configurable: true,
			value: interceptGet,
		});
	} catch (error) {
		console.warn(
			"[Bittery Passkey] Failed to install WebAuthn interceptors:",
			error,
		);
	}
}

installPasskeyInterceptors();
