import type { WorkerRpcChannel } from "./worker/owner";

export interface ReplicaExecutor {
	invoke(requestJson: string): Promise<string>;
}

export interface PlatformStorageExecutor {
	invoke(requestJson: string): Promise<string>;
}

export interface HttpExecutor {
	invoke(requestJson: string): Promise<string>;
	cancel(dispatchId: string): void;
}

interface WebClientRuntimeLike {
	cancel(requestId: string): void;
	close(): Promise<void>;
	open(): Promise<void>;
	observe_json(
		observationId: string,
		requestJson: string,
		callback: (projectionJson: string) => void,
	): void;
	request_json(requestId: string, requestJson: string): Promise<string>;
	unobserve(observationId: string): void;
}

interface RuntimeIncarnation {
	runtime: WebClientRuntimeLike;
	failed: boolean;
}

export interface AttachmentArtifactExecutor {
	invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
	): Promise<{ controlResponseJson: string; bytes?: ArrayBuffer }>;
}

export interface BinaryTransferExecutor extends AttachmentArtifactExecutor {
	close(): void;
}

export interface AccountLeaseExecutor {
	acquire(accountId: string): Promise<unknown | null>;
}

export interface RuntimeAuthClientConfig {
	clientId: string;
	platform: string;
	version: string;
}

export interface RuntimeWasm {
	WebClientRuntime: {
		withExecutors(
			replicaInvoke: (requestJson: string) => Promise<string>,
			platformStorageInvoke: (requestJson: string) => Promise<string>,
			httpInvoke: (requestJson: string) => Promise<string>,
			httpCancel: (dispatchId: string) => void,
		): WebClientRuntimeLike;
		withConfiguredExecutors?(
			replicaInvoke: (requestJson: string) => Promise<string>,
			platformStorageInvoke: (requestJson: string) => Promise<string>,
			httpInvoke: (requestJson: string) => Promise<string>,
			httpCancel: (dispatchId: string) => void,
			clientId: string,
			platform: string,
			version: string,
		): WebClientRuntimeLike;
		withConfiguredAttachmentMovePreparation?(
			replicaInvoke: (requestJson: string) => Promise<string>,
			platformStorageInvoke: (requestJson: string) => Promise<string>,
			httpInvoke: (requestJson: string) => Promise<string>,
			httpCancel: (dispatchId: string) => void,
			artifactExecutor: AttachmentArtifactExecutor,
			binaryExecutor: BinaryTransferExecutor,
			leaseExecutor: AccountLeaseExecutor,
			clientId: string,
			platform: string,
			version: string,
			lifecycleError: (errorJson: string) => void,
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
	platformStorageExecutor: PlatformStorageExecutor;
	httpExecutor: HttpExecutor;
	attachmentArtifactExecutor?: AttachmentArtifactExecutor;
	binaryTransferExecutorFactory?: () => BinaryTransferExecutor;
	accountLeaseExecutor?: AccountLeaseExecutor;
	loadWasm(): Promise<RuntimeWasm>;
	authClient?: RuntimeAuthClientConfig;
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

function closed(): Error {
	return Object.assign(new Error("The Runtime worker is closing."), {
		code: "closed",
	});
}

function attachmentPreparationFailed(): Error {
	return Object.assign(
		new Error("Attachment Move preparation lifecycle failed."),
		{ code: "ATTACHMENT_MOVE_PREPARATION_FAILED" },
	);
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
	let runtimeTask: Promise<RuntimeIncarnation> | undefined;
	let closeTask: Promise<void> | undefined;
	let restartBarrier: Promise<void> | undefined;
	let lifecycleFailure: Error | undefined;
	let terminalFailure: Error | undefined;
	let closing = false;
	const runtimeClosers = new WeakMap<
		WebClientRuntimeLike,
		() => Promise<void>
	>();
	const closeRuntime = (created: WebClientRuntimeLike): Promise<void> => {
		const closeCreated = runtimeClosers.get(created);
		if (closeCreated === undefined) {
			return Promise.reject(
				new Error("The Runtime worker lost its shutdown owner."),
			);
		}
		return closeCreated();
	};
	const rejectLifecycleFailure = async (): Promise<never> => {
		const failure = lifecycleFailure ?? attachmentPreparationFailed();
		try {
			await restartBarrier;
		} catch {
			throw terminalFailure ?? failure;
		}
		if (lifecycleFailure === failure) lifecycleFailure = undefined;
		throw failure;
	};
	const runtime = (): Promise<RuntimeIncarnation> => {
		if (terminalFailure !== undefined) {
			return Promise.reject(terminalFailure);
		}
		if (lifecycleFailure !== undefined) {
			const failure = lifecycleFailure;
			return (restartBarrier ?? Promise.resolve()).then(
				() => {
					if (lifecycleFailure === failure) lifecycleFailure = undefined;
					throw failure;
				},
				() => {
					throw terminalFailure ?? failure;
				},
			);
		}
		if (closing) return Promise.reject(closed());
		if (restartBarrier !== undefined) {
			return restartBarrier.then(runtime, () => {
				throw terminalFailure ?? attachmentPreparationFailed();
			});
		}
		if (runtimeTask !== undefined) return runtimeTask;
		let started!: Promise<RuntimeIncarnation>;
		started = deps.loadWasm().then(async ({ WebClientRuntime }) => {
			const replicaInvoke = deps.executor.invoke.bind(deps.executor);
			const platformInvoke = deps.platformStorageExecutor.invoke.bind(
				deps.platformStorageExecutor,
			);
			const httpInvoke = deps.httpExecutor.invoke.bind(deps.httpExecutor);
			const httpCancel = deps.httpExecutor.cancel.bind(deps.httpExecutor);
			let created: WebClientRuntimeLike;
			let closeCreatedTask: Promise<void> | undefined;
			const closeCreated = (): Promise<void> => {
				closeCreatedTask ??= Promise.resolve().then(() => created.close());
				return closeCreatedTask;
			};
			let lifecycleFailed = false;
			let incarnation: RuntimeIncarnation | undefined;
			if (deps.authClient !== undefined) {
				const createConfiguredRuntime =
					WebClientRuntime.withConfiguredAttachmentMovePreparation;
				if (
					createConfiguredRuntime === undefined ||
					deps.attachmentArtifactExecutor === undefined ||
					deps.binaryTransferExecutorFactory === undefined ||
					deps.accountLeaseExecutor === undefined
				) {
					throw attachmentPreparationFailed();
				}
				created = createConfiguredRuntime.call(
					WebClientRuntime,
					replicaInvoke,
					platformInvoke,
					httpInvoke,
					httpCancel,
					deps.attachmentArtifactExecutor,
					deps.binaryTransferExecutorFactory(),
					deps.accountLeaseExecutor,
					deps.authClient.clientId,
					deps.authClient.platform,
					deps.authClient.version,
					() => {
						if (lifecycleFailed || closing) return;
						lifecycleFailed = true;
						if (incarnation !== undefined) incarnation.failed = true;
						const failure = attachmentPreparationFailed();
						lifecycleFailure = failure;
						let barrier!: Promise<void>;
						barrier = closeCreated().then(
							() => {
								if (runtimeTask === started) runtimeTask = undefined;
								if (restartBarrier === barrier) restartBarrier = undefined;
							},
							() => {
								terminalFailure = failure;
								throw failure;
							},
						);
						restartBarrier = barrier;
						void barrier.catch(() => undefined);
					},
				);
			} else {
				created = WebClientRuntime.withExecutors(
					replicaInvoke,
					platformInvoke,
					httpInvoke,
					httpCancel,
				);
			}
			incarnation = { runtime: created, failed: lifecycleFailed };
			runtimeClosers.set(created, closeCreated);
			if (lifecycleFailed) return await rejectLifecycleFailure();
			try {
				await created.open();
			} catch (error) {
				const cleanupFailed = await closeCreated().then(
					() => false,
					() => true,
				);
				if (lifecycleFailed) return await rejectLifecycleFailure();
				if (cleanupFailed && deps.authClient !== undefined) {
					const failure = attachmentPreparationFailed();
					terminalFailure = failure;
					throw failure;
				}
				throw error;
			}
			if (lifecycleFailed) return await rejectLifecycleFailure();
			return incarnation;
		});
		runtimeTask = started;
		void started.catch(() => {
			if (runtimeTask === started && terminalFailure === undefined) {
				runtimeTask = undefined;
			}
		});
		return started;
	};

	return {
		async request(payload, signal, notify) {
			const command = parseCommand(payload);
			const incarnation = await runtime();
			if (incarnation.failed) return await rejectLifecycleFailure();
			const ready = incarnation.runtime;
			if (closing) throw closed();
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
				closing = true;
				closeTask =
					terminalFailure === undefined
						? (restartBarrier ??
							(runtimeTask === undefined
								? Promise.resolve()
								: runtimeTask.then(
										(ready) => closeRuntime(ready.runtime),
										() => {
											if (terminalFailure !== undefined) throw terminalFailure;
										},
									)))
						: Promise.reject(terminalFailure);
				void closeTask.catch(() => undefined);
			}
			return closeTask;
		},
	};
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
	channel: WorkerRpcChannel,
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
			// Replacing here would silently destroy the first consumer's observation and
			// leave its `unobserve` to cancel the second's. A minted id makes this
			// unreachable, so reaching it is a defect and says so.
			if (observations.has(observationId)) {
				throw invalidInput(
					`Observation ${observationId} is already installed.`,
				);
			}
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
