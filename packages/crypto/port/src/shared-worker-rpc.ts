import {
	copyWorkerValue,
	isWorkerReply,
	type WorkerChannelName,
	type WorkerReply,
	type WorkerRequest,
	WorkerRpcError,
} from "./worker-wire";

export { copyWorkerValue, WorkerRpcError } from "./worker-wire";

export interface SharedWorkerHandle {
	postMessage(message: unknown): void;
	terminate(): void;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}

export interface WorkerRpcChannel {
	request<T = unknown>(
		payload: unknown,
		options?: { signal?: AbortSignal },
	): Promise<T>;
	subscribe(listener: (value: unknown) => void): () => void;
}

export interface SharedWorkerOwner {
	channel(name: WorkerChannelName): WorkerRpcChannel;
	close(): Promise<void>;
}

export interface SharedWorkerOwnerDeps {
	createWorker: () => SharedWorkerHandle;
	handleHostRequest?: (
		payload: unknown,
		signal: AbortSignal,
	) => Promise<unknown>;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	detachAbort: () => void;
}

function backendFailure(error: unknown, fallback: string): WorkerRpcError {
	return new WorkerRpcError(
		"backend-failure",
		error instanceof Error && error.message.length > 0
			? error.message
			: fallback,
	);
}

export function createSharedWorkerOwner(
	deps: SharedWorkerOwnerDeps,
): SharedWorkerOwner {
	let worker: SharedWorkerHandle | null = null;
	let failure: WorkerRpcError | null = null;
	let closePromise: Promise<void> | null = null;
	let closed = false;
	let closeRequest: {
		id: number;
		resolve: () => void;
		reject: (error: unknown) => void;
	} | null = null;
	const nextIds = new Map<WorkerChannelName, number>();
	let nextControlId = 0;
	const pending = new Map<string, PendingRequest>();
	const listeners = new Map<WorkerChannelName, Set<(value: unknown) => void>>();
	const activeHostRequests = new Map<number, AbortController>();

	function key(channel: WorkerChannelName, id: number): string {
		return `${channel}\u0000${id}`;
	}

	function abortHostRequests(): void {
		for (const controller of activeHostRequests.values()) controller.abort();
		activeHostRequests.clear();
	}

	function failWorker(error: WorkerRpcError): void {
		if (failure !== null) return;
		failure = error;
		for (const request of pending.values()) {
			request.detachAbort();
			request.reject(error);
		}
		pending.clear();
		abortHostRequests();
		closeRequest?.reject(error);
		closeRequest = null;
		const failedWorker = worker;
		worker = null;
		if (failedWorker !== null) {
			failedWorker.onmessage = null;
			failedWorker.onerror = null;
			failedWorker.terminate();
		}
	}

	function postHostResponse(
		target: SharedWorkerHandle,
		reply: WorkerRequest,
	): void {
		try {
			target.postMessage(reply);
		} catch (error) {
			failWorker(backendFailure(error, "Could not post the host response."));
		}
	}

	function answerHostRequest(
		target: SharedWorkerHandle,
		request: Extract<WorkerReply, { type: "host-request" }>,
	): void {
		if (closePromise !== null || closed || failure !== null) {
			postHostResponse(target, {
				type: "host-response",
				id: request.id,
				ok: false,
				code: "closed",
				message: "The shared worker is closing.",
			});
			return;
		}
		const handler = deps.handleHostRequest;
		if (handler === undefined) {
			postHostResponse(target, {
				type: "host-response",
				id: request.id,
				ok: false,
				code: "closed",
				message: "No host request handler is attached.",
			});
			return;
		}
		const controller = new AbortController();
		activeHostRequests.set(request.id, controller);
		void Promise.resolve()
			.then(() => handler(copyWorkerValue(request.payload), controller.signal))
			.then((value) => {
				if (activeHostRequests.get(request.id) !== controller) return;
				const wireValue = copyWorkerValue(value);
				activeHostRequests.delete(request.id);
				postHostResponse(target, {
					type: "host-response",
					id: request.id,
					ok: true,
					value: wireValue,
				});
			})
			.catch((error: unknown) => {
				if (activeHostRequests.get(request.id) !== controller) return;
				activeHostRequests.delete(request.id);
				const record = error as { code?: unknown; message?: unknown };
				postHostResponse(target, {
					type: "host-response",
					id: request.id,
					ok: false,
					code:
						typeof record.code === "string" ? record.code : "backend-failure",
					message:
						typeof record.message === "string"
							? record.message
							: "The host request failed.",
				});
			});
	}

	function ensureWorker(): SharedWorkerHandle {
		if (failure !== null) throw failure;
		if (worker === null) {
			worker = deps.createWorker();
			worker.onmessage = (event) => {
				if (!isWorkerReply(event.data)) return;
				const reply = event.data;
				if (reply.type === "host-request") {
					const target = worker;
					if (target !== null) answerHostRequest(target, reply);
					return;
				}
				if (reply.type === "notification") {
					for (const listener of listeners.get(reply.channel) ?? []) {
						listener(reply.value);
					}
					return;
				}
				if (reply.type === "close-ack") {
					if (closeRequest === null || reply.id !== closeRequest.id) return;
					const closing = closeRequest;
					closeRequest = null;
					const completedWorker = worker;
					worker = null;
					if (completedWorker !== null) {
						completedWorker.onmessage = null;
						completedWorker.onerror = null;
						completedWorker.terminate();
					}
					closed = true;
					if (reply.ok) closing.resolve();
					else closing.reject(new WorkerRpcError(reply.code, reply.message));
					return;
				}
				if (reply.type !== "response") return;
				const request = pending.get(key(reply.channel, reply.id));
				if (request === undefined) return;
				pending.delete(key(reply.channel, reply.id));
				request.detachAbort();
				if (reply.ok) request.resolve(reply.value);
				else request.reject(new WorkerRpcError(reply.code, reply.message));
			};
			worker.onerror = (event) => {
				failWorker(
					new WorkerRpcError(
						"backend-failure",
						event.message || "The shared worker failed.",
					),
				);
			};
		}
		return worker;
	}

	return {
		channel(channel) {
			return {
				subscribe(listener) {
					let channelListeners = listeners.get(channel);
					if (channelListeners === undefined) {
						channelListeners = new Set();
						listeners.set(channel, channelListeners);
					}
					channelListeners.add(listener);
					return () => {
						channelListeners?.delete(listener);
						if (channelListeners?.size === 0) listeners.delete(channel);
					};
				},
				request<T = unknown>(
					payload: unknown,
					options?: { signal?: AbortSignal },
				) {
					if (closed || closePromise !== null) {
						return Promise.reject(
							new WorkerRpcError("closed", "The shared worker is closed."),
						);
					}
					if (options?.signal?.aborted) {
						return Promise.reject(
							new WorkerRpcError(
								"cancelled",
								"The worker request was cancelled.",
							),
						);
					}
					let target: SharedWorkerHandle;
					let wirePayload: unknown;
					try {
						wirePayload = copyWorkerValue(payload);
						target = ensureWorker();
					} catch (error) {
						return Promise.reject(error);
					}
					const id = nextIds.get(channel) ?? 0;
					nextIds.set(channel, id + 1);
					const answer = new Promise<unknown>((resolve, reject) => {
						const abort = () => {
							if (!pending.delete(key(channel, id))) return;
							try {
								target.postMessage({
									type: "cancel",
									channel,
									id,
								} satisfies WorkerRequest);
							} catch {
								// The local wait is already cancelled; a failed best-effort cancel
								// cannot make the caller wait again.
							}
							reject(
								new WorkerRpcError(
									"cancelled",
									"The worker request was cancelled.",
								),
							);
						};
						options?.signal?.addEventListener("abort", abort, { once: true });
						pending.set(key(channel, id), {
							resolve,
							reject,
							detachAbort: () =>
								options?.signal?.removeEventListener("abort", abort),
						});
					});
					try {
						target.postMessage({
							type: "request",
							channel,
							id,
							payload: wirePayload,
						} satisfies WorkerRequest);
					} catch (error) {
						const request = pending.get(key(channel, id));
						pending.delete(key(channel, id));
						request?.detachAbort();
						request?.reject(
							backendFailure(error, "Could not post the worker request."),
						);
					}
					return answer as Promise<T>;
				},
			};
		},
		close() {
			if (closePromise !== null) return closePromise;
			if (failure !== null) return Promise.reject(failure);
			if (closed) return Promise.resolve();
			if (worker === null) {
				closed = true;
				return Promise.resolve();
			}
			for (const request of pending.values()) {
				request.detachAbort();
				request.reject(
					new WorkerRpcError("closed", "The shared worker is closing."),
				);
			}
			pending.clear();
			abortHostRequests();
			const target = worker;
			const id = nextControlId++;
			closePromise = new Promise<void>((resolve, reject) => {
				closeRequest = { id, resolve, reject };
			});
			try {
				target.postMessage({ type: "close", id } satisfies WorkerRequest);
			} catch (error) {
				failure = backendFailure(
					error,
					"Could not post the worker close request.",
				);
				closeRequest?.reject(failure);
				closeRequest = null;
				target.onmessage = null;
				target.onerror = null;
				target.terminate();
				worker = null;
			}
			return closePromise;
		},
	};
}
