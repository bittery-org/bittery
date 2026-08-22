import {
	copyWorkerValue,
	isWorkerRequest,
	type WorkerChannelName,
	type WorkerReply,
} from "./worker-wire";

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

interface ChannelRequest {
	channel: WorkerChannelName;
	id: number;
	payload: unknown;
}

export function serveWorkerChannels(
	scope: WorkerRouterScope,
	services: Readonly<Partial<Record<WorkerChannelName, WorkerChannelService>>>,
): void {
	const active = new Map<string, AbortController>();
	const key = (channel: WorkerChannelName, id: number) =>
		`${channel}\u0000${id}`;
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
					scope.postMessage({
						type: "close-ack",
						id: message.id,
						ok: true,
					} satisfies WorkerReply),
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
					} satisfies WorkerReply);
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
			} satisfies WorkerReply);
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
				} satisfies WorkerReply);
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
				} satisfies WorkerReply);
			});
	});
}
