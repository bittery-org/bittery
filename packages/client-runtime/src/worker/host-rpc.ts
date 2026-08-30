import {
	copyWorkerValue,
	isWorkerRequest,
	prepareWorkerValueForPost,
	type WorkerReply,
	WorkerRpcError,
} from "./wire";

export interface WorkerHostRpcScope {
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	postMessage(message: unknown, transfer?: Transferable[]): void;
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
	const pending = new Map<number, PendingHostRequest>();

	scope.addEventListener("message", (event) => {
		if (!isWorkerRequest(event.data)) return;
		const message = event.data;
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
			let prepared: ReturnType<typeof prepareWorkerValueForPost>;
			try {
				prepared = prepareWorkerValueForPost(payload);
			} catch (error) {
				return Promise.reject(error);
			}
			const id = nextId++;
			const answer = new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject });
			});
			try {
				scope.postMessage(
					{
						type: "host-request",
						id,
						payload: prepared.value,
					} satisfies WorkerReply,
					prepared.transfer,
				);
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
