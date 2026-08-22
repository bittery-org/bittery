import { copyWorkerValue } from "./shared-worker-rpc";

export interface WorkerRouterScope {
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	postMessage(message: unknown): void;
}

export interface WorkerChannelService {
	request(payload: unknown, signal: AbortSignal): Promise<unknown>;
	close?(): Promise<void>;
}

type WorkerRequest =
	| {
			type: "request";
			channel: string;
			id: number;
			payload: unknown;
	  }
	| { type: "cancel"; channel: string; id: number }
	| { type: "close"; id: number };

interface ChannelRequest {
	channel: string;
	id: number;
	payload: unknown;
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Partial<WorkerRequest>;
	if (message.type === "close") return typeof message.id === "number";
	if (message.type === "cancel") {
		return (
			typeof message.channel === "string" && typeof message.id === "number"
		);
	}
	return (
		message.type === "request" &&
		typeof message.channel === "string" &&
		typeof message.id === "number" &&
		"payload" in message
	);
}

export function serveWorkerChannels(
	scope: WorkerRouterScope,
	services: Readonly<Record<string, WorkerChannelService>>,
): void {
	const active = new Map<string, AbortController>();
	const key = (channel: string, id: number) => `${channel}\u0000${id}`;
	let closeTask: Promise<void> | null = null;
	scope.addEventListener("message", (event) => {
		if (!isWorkerRequest(event.data)) return;
		const message = event.data;
		if (message.type === "close") {
			for (const controller of active.values()) controller.abort();
			active.clear();
			closeTask ??= Promise.all(
				Object.values(services).map((service) => service.close?.()),
			).then(() => undefined);
			void closeTask.then(
				() =>
					scope.postMessage({ type: "close-ack", id: message.id, ok: true }),
				(error: unknown) => {
					const record = error as { code?: unknown; message?: unknown };
					scope.postMessage({
						type: "close-ack",
						id: message.id,
						ok: false,
						code:
							typeof record.code === "string" ? record.code : "backend-failure",
						message:
							typeof record.message === "string"
								? record.message
								: "The worker failed to close.",
					});
				},
			);
			return;
		}
		if (message.type === "cancel") {
			active.get(key(message.channel, message.id))?.abort();
			active.delete(key(message.channel, message.id));
			return;
		}
		if (message.type !== "request") return;
		const request = message as ChannelRequest;
		const service = services[request.channel];
		if (service === undefined) {
			scope.postMessage({
				type: "response",
				channel: request.channel,
				id: request.id,
				ok: false,
				code: "closed",
				message: `Worker channel "${request.channel}" is not attached.`,
			});
			return;
		}
		const controller = new AbortController();
		active.set(key(request.channel, request.id), controller);
		void Promise.resolve()
			.then(() =>
				service.request(copyWorkerValue(request.payload), controller.signal),
			)
			.then((value) => {
				active.delete(key(request.channel, request.id));
				scope.postMessage({
					type: "response",
					channel: request.channel,
					id: request.id,
					ok: true,
					value: copyWorkerValue(value),
				});
			})
			.catch((error: unknown) => {
				active.delete(key(request.channel, request.id));
				const record = error as { code?: unknown; message?: unknown };
				scope.postMessage({
					type: "response",
					channel: request.channel,
					id: request.id,
					ok: false,
					code:
						typeof record.code === "string" ? record.code : "backend-failure",
					message:
						typeof record.message === "string"
							? record.message
							: "The worker channel request failed.",
				});
			});
	});
}
