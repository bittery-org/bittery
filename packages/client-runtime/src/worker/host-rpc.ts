import {
	isAttachmentUploadSourceWorkerRequest,
	isWorkerRequest,
	prepareWorkerValueForPost,
	receiveHostResponseValue,
	type WorkerReply,
	WorkerRpcError,
	wipeAttachmentUploadSourceResponseBinary,
	wipeWorkerEnvelopeBinary,
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
	expectsAttachmentUploadSource: boolean;
}

/**
 * The Worker-side half of the generic reverse RPC. Host behavior is injected by the
 * owner; this transport knows only clone-safe payloads, correlation, and lifetime.
 */
export function createWorkerHostRpc(scope: WorkerHostRpcScope): WorkerHostRpc {
	let nextId = 0;
	const pending = new Map<number, PendingHostRequest>();

	scope.addEventListener("message", (event) => {
		if (!isWorkerRequest(event.data)) {
			wipeWorkerEnvelopeBinary(event.data);
			return;
		}
		const message = event.data;
		if (message.type !== "host-response") return;
		const request = pending.get(message.id);
		if (request === undefined) {
			if (message.ok) wipeAttachmentUploadSourceResponseBinary(message.value);
			return;
		}
		if (!message.ok) {
			pending.delete(message.id);
			request.reject(new WorkerRpcError(message.code, message.message));
			return;
		}
		try {
			const value = receiveHostResponseValue(
				message.value,
				request.expectsAttachmentUploadSource,
			);
			pending.delete(message.id);
			request.resolve(value);
		} catch {}
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
				pending.set(id, {
					resolve,
					reject,
					expectsAttachmentUploadSource:
						isAttachmentUploadSourceWorkerRequest(payload),
				});
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
				wipeAttachmentUploadSourceResponseBinary(payload);
				wipeAttachmentUploadSourceResponseBinary(prepared.value);
				const message =
					typeof error === "object" && error !== null
						? Object.getOwnPropertyDescriptor(error, "message")?.value
						: undefined;
				return Promise.reject(
					new WorkerRpcError(
						"backend-failure",
						typeof message === "string" && message.length > 0
							? message
							: "Could not post the host request.",
					),
				);
			}
			return answer as Promise<T>;
		},
	};
}
