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
}

export interface SharedWorkerOwner {
	channel(name: string): WorkerRpcChannel;
	close(): Promise<void>;
}

export interface SharedWorkerOwnerDeps {
	createWorker: () => SharedWorkerHandle;
}

type WorkerReply =
	| { type: "response"; channel: string; id: number; ok: true; value: unknown }
	| {
			type: "response";
			channel: string;
			id: number;
			ok: false;
			code: string;
			message: string;
	  }
	| { type: "close-ack"; id: number; ok: true }
	| { type: "close-ack"; id: number; ok: false; code: string; message: string };

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	detachAbort: () => void;
}

function isWorkerReply(value: unknown): value is WorkerReply {
	if (typeof value !== "object" || value === null) return false;
	const reply = value as Record<string, unknown>;
	if (reply.type === "close-ack") {
		return (
			typeof reply.id === "number" &&
			typeof reply.ok === "boolean" &&
			(reply.ok ||
				(typeof reply.code === "string" && typeof reply.message === "string"))
		);
	}
	if (reply.type !== "response") return false;
	if (
		typeof reply.channel !== "string" ||
		typeof reply.id !== "number" ||
		typeof reply.ok !== "boolean"
	) {
		return false;
	}
	return (
		reply.ok ||
		(typeof reply.code === "string" && typeof reply.message === "string")
	);
}

export class WorkerRpcError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "WorkerRpcError";
	}
}

function backendFailure(error: unknown, fallback: string): WorkerRpcError {
	return new WorkerRpcError(
		"backend-failure",
		error instanceof Error && error.message.length > 0
			? error.message
			: fallback,
	);
}

/** Validate the deliberately small worker wire vocabulary and copy every byte buffer. */
export function copyWorkerValue(
	value: unknown,
	seen: Set<object> = new Set(),
): unknown {
	if (
		value === undefined ||
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value;
	}
	if (typeof value !== "object") {
		throw new WorkerRpcError(
			"invalid-input",
			"The worker boundary accepts only plain data and byte arrays.",
		);
	}
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (seen.has(value)) {
		throw new WorkerRpcError(
			"invalid-input",
			"Cyclic worker values are forbidden.",
		);
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((member) => copyWorkerValue(member, seen));
		}
		const prototype = Object.getPrototypeOf(value) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new WorkerRpcError(
				"invalid-input",
				"The worker boundary accepts only plain data and byte arrays.",
			);
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new WorkerRpcError(
				"invalid-input",
				"Symbol properties are forbidden at the worker boundary.",
			);
		}
		const copy: Record<string, unknown> = {};
		for (const [name, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(value),
		)) {
			if (descriptor.get !== undefined || descriptor.set !== undefined) {
				throw new WorkerRpcError(
					"invalid-input",
					"Accessor properties are forbidden at the worker boundary.",
				);
			}
			copy[name] = copyWorkerValue(descriptor.value, seen);
		}
		return copy;
	} finally {
		seen.delete(value);
	}
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
	const nextIds = new Map<string, number>();
	let nextControlId = 0;
	const pending = new Map<string, PendingRequest>();

	function key(channel: string, id: number): string {
		return `${channel}\u0000${id}`;
	}

	function ensureWorker(): SharedWorkerHandle {
		if (failure !== null) throw failure;
		if (worker === null) {
			worker = deps.createWorker();
			worker.onmessage = (event) => {
				if (!isWorkerReply(event.data)) return;
				const reply = event.data;
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
				failure = new WorkerRpcError(
					"backend-failure",
					event.message || "The shared worker failed.",
				);
				for (const request of pending.values()) {
					request.detachAbort();
					request.reject(failure);
				}
				pending.clear();
				closeRequest?.reject(failure);
				closeRequest = null;
				const failedWorker = worker;
				worker = null;
				if (failedWorker !== null) {
					failedWorker.onmessage = null;
					failedWorker.onerror = null;
					failedWorker.terminate();
				}
			};
		}
		return worker;
	}

	return {
		channel(channel) {
			return {
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
								target.postMessage({ type: "cancel", channel, id });
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
						});
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
			const target = worker;
			const id = nextControlId++;
			closePromise = new Promise<void>((resolve, reject) => {
				closeRequest = { id, resolve, reject };
			});
			try {
				target.postMessage({ type: "close", id });
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
