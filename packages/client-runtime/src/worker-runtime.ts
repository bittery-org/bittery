export interface ReplicaExecutor {
	invoke(requestJson: string): Promise<string>;
}

interface WebClientRuntimeLike {
	cancel(requestId: string): void;
	close(): Promise<void>;
	observe_json(
		observationId: string,
		requestJson: string,
		callback: (projectionJson: string) => void,
	): void;
	request_json(requestId: string, requestJson: string): Promise<string>;
	unobserve(observationId: string): void;
}

export interface RuntimeWasm {
	WebClientRuntime: {
		withReplicaExecutor(
			invoke: (requestJson: string) => Promise<string>,
		): WebClientRuntimeLike;
	};
}

export interface RuntimeWorkerService {
	request(
		payload: unknown,
		signal: AbortSignal,
		notify: (value: unknown) => void,
	): Promise<unknown>;
	close(): Promise<void>;
}

export interface RuntimeWorkerServiceDeps {
	executor: ReplicaExecutor;
	loadWasm(): Promise<RuntimeWasm>;
}

type RuntimeCommand =
	| { type: "request"; requestId: string; requestJson: string }
	| { type: "observe"; observationId: string; requestJson: string }
	| { type: "unobserve"; observationId: string };

type RuntimeNotification = {
	type: "observation";
	observationId: string;
	projectionJson: string;
};

function invalidInput(message: string): Error {
	return Object.assign(new Error(message), { code: "invalid-input" });
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(value);
	return (
		actual.length === keys.length && keys.every((key) => actual.includes(key))
	);
}

function parseCommand(value: unknown): RuntimeCommand {
	if (typeof value !== "object" || value === null) {
		throw invalidInput("Runtime commands must be plain objects.");
	}
	const command = value as Record<string, unknown>;
	if (
		command.type === "request" &&
		typeof command.requestId === "string" &&
		typeof command.requestJson === "string" &&
		hasExactKeys(command, ["type", "requestId", "requestJson"])
	) {
		return command as RuntimeCommand;
	}
	if (
		command.type === "observe" &&
		typeof command.observationId === "string" &&
		typeof command.requestJson === "string" &&
		hasExactKeys(command, ["type", "observationId", "requestJson"])
	) {
		return command as RuntimeCommand;
	}
	if (
		command.type === "unobserve" &&
		typeof command.observationId === "string" &&
		hasExactKeys(command, ["type", "observationId"])
	) {
		return command as RuntimeCommand;
	}
	throw invalidInput("Unknown or malformed Runtime worker command.");
}

export function createRuntimeWorkerService(
	deps: RuntimeWorkerServiceDeps,
): RuntimeWorkerService {
	let runtimeTask: Promise<WebClientRuntimeLike> | undefined;
	let closeTask: Promise<void> | undefined;
	const runtime = () =>
		(runtimeTask ??= deps
			.loadWasm()
			.then(({ WebClientRuntime }) =>
				WebClientRuntime.withReplicaExecutor(
					deps.executor.invoke.bind(deps.executor),
				),
			));

	return {
		async request(payload, signal, notify) {
			const command = parseCommand(payload);
			const ready = await runtime();
			if (command.type === "observe") {
				if (signal.aborted) return undefined;
				let cancelled = false;
				const cancel = () => {
					if (cancelled) return;
					cancelled = true;
					ready.unobserve(command.observationId);
				};
				signal.addEventListener("abort", cancel, { once: true });
				ready.observe_json(
					command.observationId,
					command.requestJson,
					(projectionJson) =>
						notify({
							type: "observation",
							observationId: command.observationId,
							projectionJson,
						} satisfies RuntimeNotification),
				);
				if (signal.aborted) cancel();
				signal.removeEventListener("abort", cancel);
				return undefined;
			}
			if (command.type === "unobserve") {
				ready.unobserve(command.observationId);
				return undefined;
			}
			const cancel = () => ready.cancel(command.requestId);
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
			try {
				return await ready.request_json(command.requestId, command.requestJson);
			} finally {
				signal.removeEventListener("abort", cancel);
			}
		},
		close() {
			if (closeTask === undefined) {
				closeTask =
					runtimeTask === undefined
						? Promise.resolve()
						: runtimeTask.then((ready) => ready.close());
			}
			return closeTask;
		},
	};
}

export interface RuntimeRpcChannel {
	request<T = unknown>(
		payload: unknown,
		options?: { signal?: AbortSignal },
	): Promise<T>;
	subscribe(listener: (value: unknown) => void): () => void;
}

export interface WorkerRuntime {
	request(
		requestId: string,
		requestJson: string,
		options?: { signal?: AbortSignal },
	): Promise<string>;
	observe(
		observationId: string,
		requestJson: string,
		listener: (projectionJson: string) => void,
		options?: { signal?: AbortSignal },
	): Promise<void>;
	unobserve(observationId: string): Promise<void>;
	close(): Promise<void>;
}

function notification(value: unknown): RuntimeNotification | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<RuntimeNotification>;
	return candidate.type === "observation" &&
		typeof candidate.observationId === "string" &&
		typeof candidate.projectionJson === "string"
		? (candidate as RuntimeNotification)
		: null;
}

export function createWorkerRuntime(
	channel: RuntimeRpcChannel,
	closeOwner: () => Promise<void>,
): WorkerRuntime {
	const observations = new Map<string, (projectionJson: string) => void>();
	const detach = channel.subscribe((value) => {
		const event = notification(value);
		if (event === null) return;
		observations.get(event.observationId)?.(event.projectionJson);
	});
	let closeTask: Promise<void> | undefined;

	return {
		request(requestId, requestJson, options) {
			return channel.request<string>(
				{ type: "request", requestId, requestJson } satisfies RuntimeCommand,
				options,
			);
		},
		async observe(observationId, requestJson, listener, options) {
			observations.set(observationId, listener);
			try {
				await channel.request(
					{
						type: "observe",
						observationId,
						requestJson,
					} satisfies RuntimeCommand,
					options,
				);
			} catch (error) {
				if (observations.get(observationId) === listener) {
					observations.delete(observationId);
				}
				if (options?.signal?.aborted) {
					try {
						await channel.request({
							type: "unobserve",
							observationId,
						} satisfies RuntimeCommand);
					} catch {
						// The original cancellation remains authoritative; worker close/crash
						// already guarantees the observation cannot survive.
					}
				}
				throw error;
			}
		},
		async unobserve(observationId) {
			observations.delete(observationId);
			await channel.request({
				type: "unobserve",
				observationId,
			} satisfies RuntimeCommand);
		},
		close() {
			if (closeTask === undefined) {
				detach();
				observations.clear();
				closeTask = closeOwner();
			}
			return closeTask;
		},
	};
}
