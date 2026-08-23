import {
	copyWorkerValue,
	isWorkerRequest,
	type WorkerReply,
	WorkerRpcError,
} from "./worker-wire";

export interface WorkerHostRpcScope {
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	postMessage(message: unknown): void;
}

export interface WorkerHostRpc {
	request<T = unknown>(payload: unknown): Promise<T>;
}

interface PendingHostRequest {
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

/**
 * The Worker-side half of the generic reverse RPC. Host behavior is injected by the
 * owner; this transport knows only clone-safe payloads, correlation, and lifetime.
 */
export function createWorkerHostRpc(scope: WorkerHostRpcScope): WorkerHostRpc {
	let nextId = 0;
	let closed = false;
	const pending = new Map<number, PendingHostRequest>();

	scope.addEventListener("message", (event) => {
		if (!isWorkerRequest(event.data)) return;
		const message = event.data;
		if (message.type === "close") {
			closed = true;
			const error = new WorkerRpcError(
				"closed",
				"The shared worker is closing.",
			);
			for (const request of pending.values()) request.reject(error);
			pending.clear();
			return;
		}
		if (message.type !== "host-response") return;
		const request = pending.get(message.id);
		if (request === undefined) return;
		pending.delete(message.id);
		if (!message.ok) {
			request.reject(new WorkerRpcError(message.code, message.message));
			return;
		}
		try {
			request.resolve(copyWorkerValue(message.value));
		} catch (error) {
			request.reject(error);
		}
	});

	return {
		request<T = unknown>(payload: unknown): Promise<T> {
			if (closed) {
				return Promise.reject(
					new WorkerRpcError("closed", "The shared worker is closed."),
				);
			}
			let wirePayload: unknown;
			try {
				wirePayload = copyWorkerValue(payload);
			} catch (error) {
				return Promise.reject(error);
			}
			const id = nextId++;
			const answer = new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject });
			});
			try {
				scope.postMessage({
					type: "host-request",
					id,
					payload: wirePayload,
				} satisfies WorkerReply);
			} catch (error) {
				pending.delete(id);
				return Promise.reject(
					new WorkerRpcError(
						"backend-failure",
						error instanceof Error && error.message.length > 0
							? error.message
							: "Could not post the host request.",
					),
				);
			}
			return answer as Promise<T>;
		},
	};
}
