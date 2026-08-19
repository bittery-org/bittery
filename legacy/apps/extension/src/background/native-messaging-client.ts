import { NATIVE_HOST_NAME } from "./constants";
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopEnvelope,
	type DesktopEventPayload,
	DesktopProtocolMismatchError,
	type DesktopRequest,
	type DesktopResponse,
} from "./desktop-protocol";

const REQUEST_TIMEOUT_MS = 30000;
const RECONNECT_DELAY_MS = 1000;

type PendingRequest = {
	resolve: (value: DesktopResponse) => void;
	reject: (reason?: unknown) => void;
	timeoutId: ReturnType<typeof setTimeout>;
};

type NativeMessagingClientDeps = {
	connectNative?: typeof chrome.runtime.connectNative;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDesktopResponseEnvelope(
	value: unknown,
): value is DesktopEnvelope<DesktopResponse> {
	return (
		isRecord(value) &&
		(value.protocolVersion === undefined ||
			typeof value.protocolVersion === "number") &&
		typeof value.type === "string" &&
		(value.requestId === undefined || typeof value.requestId === "string")
	);
}

function isDesktopEventPayload(value: unknown): value is DesktopEventPayload {
	if (!isRecord(value) || !isRecord(value.payload)) {
		return false;
	}

	switch (value.event) {
		case "lock":
			return (
				typeof value.payload.reason === "string" &&
				typeof value.payload.timestamp === "number"
			);
		case "unlock":
			return (
				Array.isArray(value.payload.accounts) &&
				value.payload.accounts.every(
					(account) => typeof account === "string",
				) &&
				typeof value.payload.timestamp === "number"
			);
		case "desktop_close":
			return typeof value.payload.timestamp === "number";
		case "active_account_changed":
			return (
				typeof value.payload.accountId === "string" &&
				typeof value.payload.timestamp === "number"
			);
		case "theme_changed":
			return (
				(value.payload.theme === "light" ||
					value.payload.theme === "dark" ||
					value.payload.theme === "system") &&
				typeof value.payload.timestamp === "number"
			);
		default:
			return false;
	}
}

function getDefaultConnectNative(): typeof chrome.runtime.connectNative {
	return (application: string) => {
		if (!globalThis.chrome?.runtime?.connectNative) {
			throw new Error("chrome.runtime.connectNative is unavailable");
		}

		return globalThis.chrome.runtime.connectNative(application);
	};
}

export class NativeMessagingClient {
	private readonly connectNativeImpl: typeof chrome.runtime.connectNative;
	private port: chrome.runtime.Port | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private desktopEventListeners = new Set<
		(event: DesktopEventPayload) => void
	>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private subscribedToDesktopEvents = false;
	private protocolMismatchDetected = false;
	private requestCounter = 0;

	constructor(deps: NativeMessagingClientDeps = {}) {
		this.connectNativeImpl = deps.connectNative ?? getDefaultConnectNative();
	}

	private nextRequestId(): string {
		this.requestCounter += 1;
		return `desktop-${Date.now()}-${this.requestCounter}`;
	}

	private ensurePort(): chrome.runtime.Port {
		if (this.port && !this.protocolMismatchDetected) {
			return this.port;
		}
		if (this.port) {
			const incompatiblePort = this.port;
			this.port = null;
			incompatiblePort.disconnect();
		}

		const port = this.connectNativeImpl(NATIVE_HOST_NAME);
		port.onMessage.addListener((message) => {
			this.handleMessage(message);
		});
		port.onDisconnect.addListener(() => {
			this.handleDisconnect(port);
		});
		this.port = port;
		this.protocolMismatchDetected = false;
		return port;
	}

	private handleMessage(message: unknown): void {
		if (!isDesktopResponseEnvelope(message)) {
			return;
		}
		if (message.protocolVersion !== DESKTOP_PROTOCOL_VERSION) {
			this.handleProtocolMismatch(message.protocolVersion);
			return;
		}
		if (message.type === "PROTOCOL_MISMATCH") {
			const receivedVersion =
				typeof message.receivedVersion === "number"
					? message.receivedVersion
					: undefined;
			const expectedVersion =
				typeof message.expectedVersion === "number"
					? message.expectedVersion
					: DESKTOP_PROTOCOL_VERSION;
			this.handleProtocolMismatch(receivedVersion, expectedVersion);
			return;
		}

		if (message.type === "DESKTOP_EVENT") {
			const event: unknown = message;
			if (!isDesktopEventPayload(event)) {
				return;
			}
			for (const listener of this.desktopEventListeners) {
				listener(event);
			}
			return;
		}

		if (!message.requestId) {
			return;
		}

		const pending = this.pendingRequests.get(message.requestId);
		if (!pending) {
			return;
		}

		clearTimeout(pending.timeoutId);
		this.pendingRequests.delete(message.requestId);
		pending.resolve(message);
	}

	private handleProtocolMismatch(
		receivedVersion: number | undefined,
		// Annotated, not inferred: the pinned version is a literal type now, and
		// the peer is entitled to name any version in a mismatch report.
		expectedVersion: number = DESKTOP_PROTOCOL_VERSION,
	): void {
		const error = new DesktopProtocolMismatchError(
			expectedVersion,
			receivedVersion,
		);
		console.error("[native-messaging-client] Desktop protocol mismatch", {
			expectedVersion: error.expectedVersion,
			receivedVersion: error.receivedVersion,
		});

		this.protocolMismatchDetected = true;
		this.subscribedToDesktopEvents = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	private handleDisconnect(disconnectedPort: chrome.runtime.Port): void {
		if (this.port !== disconnectedPort) {
			return;
		}

		const error = chrome.runtime.lastError;
		const reason = error?.message || "Native host disconnected";

		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error(`Native host disconnected: ${reason}`));
		}
		this.pendingRequests.clear();
		this.port = null;
		this.subscribedToDesktopEvents = false;

		if (
			!this.protocolMismatchDetected &&
			this.desktopEventListeners.size > 0 &&
			!this.reconnectTimer
		) {
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				void this.ensureDesktopEventSubscription();
			}, RECONNECT_DELAY_MS);
		}
	}

	request(
		message: DesktopRequest,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<DesktopResponse> {
		return new Promise((resolve, reject) => {
			let requestId: string | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			try {
				const port = this.ensurePort();
				const nextRequestId = this.nextRequestId();
				requestId = nextRequestId;
				timeoutId = setTimeout(() => {
					this.pendingRequests.delete(nextRequestId);
					reject(new Error("Native messaging timeout"));
				}, timeoutMs);

				this.pendingRequests.set(nextRequestId, {
					resolve,
					reject,
					timeoutId,
				});

				port.postMessage({
					requestId: nextRequestId,
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					...message,
				} satisfies DesktopEnvelope<DesktopRequest>);
			} catch (error) {
				if (requestId) {
					this.pendingRequests.delete(requestId);
				}
				if (timeoutId) {
					clearTimeout(timeoutId);
				}
				reject(error);
			}
		});
	}

	private async ensureDesktopEventSubscription(): Promise<void> {
		if (
			this.subscribedToDesktopEvents ||
			this.desktopEventListeners.size === 0
		) {
			return;
		}

		const response = await this.request({
			type: "SUBSCRIBE_DESKTOP_EVENTS",
		});
		if (response.type === "DESKTOP_EVENT_SUBSCRIPTION" && response.subscribed) {
			this.subscribedToDesktopEvents = true;
		}
	}

	private async maybeUnsubscribeDesktopEvents(): Promise<void> {
		if (
			!this.subscribedToDesktopEvents ||
			this.desktopEventListeners.size > 0
		) {
			return;
		}

		try {
			await this.request({
				type: "UNSUBSCRIBE_DESKTOP_EVENTS",
			});
		} finally {
			this.subscribedToDesktopEvents = false;
		}
	}

	subscribeToDesktopEvents(
		listener: (event: DesktopEventPayload) => void,
	): () => void {
		this.desktopEventListeners.add(listener);
		void this.ensureDesktopEventSubscription().catch((error) => {
			if (error instanceof DesktopProtocolMismatchError) {
				return;
			}
			console.error(
				"[native-messaging-client] Failed to subscribe to desktop events:",
				error,
			);
		});

		return () => {
			this.desktopEventListeners.delete(listener);
			void this.maybeUnsubscribeDesktopEvents().catch((error) => {
				console.error(
					"[native-messaging-client] Failed to unsubscribe from desktop events:",
					error,
				);
			});
		};
	}
}

export const nativeMessagingClient = new NativeMessagingClient();

export function sendNativeMessage(
	message: DesktopRequest,
): Promise<DesktopResponse> {
	return nativeMessagingClient.request(message);
}
