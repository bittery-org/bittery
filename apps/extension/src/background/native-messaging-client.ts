import { NATIVE_HOST_NAME } from "./constants";
import type {
	DesktopEnvelope,
	DesktopEventPayload,
	DesktopRequest,
	DesktopResponse,
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
	private requestCounter = 0;

	constructor(deps: NativeMessagingClientDeps = {}) {
		this.connectNativeImpl = deps.connectNative ?? getDefaultConnectNative();
	}

	private nextRequestId(): string {
		this.requestCounter += 1;
		return `desktop-${Date.now()}-${this.requestCounter}`;
	}

	private ensurePort(): chrome.runtime.Port {
		if (this.port) {
			return this.port;
		}

		const port = this.connectNativeImpl(NATIVE_HOST_NAME);
		port.onMessage.addListener((message) => {
			this.handleMessage(message as DesktopEnvelope<DesktopResponse>);
		});
		port.onDisconnect.addListener(() => {
			this.handleDisconnect();
		});
		this.port = port;
		return port;
	}

	private handleMessage(message: DesktopEnvelope<DesktopResponse>): void {
		if (message.type === "DESKTOP_EVENT") {
			const event = message as unknown as DesktopEventPayload;
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

	private handleDisconnect(): void {
		const error = chrome.runtime.lastError;
		const reason = error?.message || "Native host disconnected";

		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeoutId);
			pending.reject(new Error(`Native host disconnected: ${reason}`));
		}
		this.pendingRequests.clear();
		this.port = null;
		this.subscribedToDesktopEvents = false;

		if (this.desktopEventListeners.size > 0 && !this.reconnectTimer) {
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = null;
				void this.ensureDesktopEventSubscription();
			}, RECONNECT_DELAY_MS);
		}
	}

	request<TResponse extends DesktopResponse = DesktopResponse>(
		message: DesktopRequest,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<TResponse> {
		return new Promise((resolve, reject) => {
			try {
				const requestId = this.nextRequestId();
				const timeoutId = setTimeout(() => {
					this.pendingRequests.delete(requestId);
					reject(new Error("Native messaging timeout"));
				}, timeoutMs);

				this.pendingRequests.set(requestId, {
					resolve: (value) => resolve(value as TResponse),
					reject,
					timeoutId,
				});

				this.ensurePort().postMessage({
					requestId,
					...message,
				} satisfies DesktopEnvelope<DesktopRequest>);
			} catch (error) {
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

export function sendNativeMessage<
	TResponse extends DesktopResponse = DesktopResponse,
>(message: DesktopRequest): Promise<TResponse> {
	return nativeMessagingClient.request<TResponse>(message);
}
