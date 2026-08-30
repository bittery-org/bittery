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
	/** Present only when `open()` rejected. See `WedgedRuntime`. */
	wedged?: WedgedRuntime;
}

/**
 * A Runtime that was built but could not open.
 *
 * `open()` fails for as long as the persisted Device state is unreadable or disagrees with itself,
 * so it fails again on every reload. That is exactly the Device a user asks to wipe, and the
 * Runtime stays the only authority that may destroy Device storage. The un-opened Runtime is
 * therefore kept alive for a Device wipe alone. Every other request retires it first and reports
 * the `open()` failure, which keeps the established behaviour: the next request builds and opens a
 * new Runtime.
 */
interface WedgedRuntime {
	error: unknown;
	/** Keeps the un-opened Runtime alive while a wipe is still using it. */
	hold(): void;
	release(): void;
	/**
	 * Closes the un-opened Runtime unless a wipe still holds it, and drops it from the cache so the
	 * next request starts over.
	 */
	retire(): Promise<void>;
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

export interface AttachmentDownloadSinkExecutor {
	invoke(controlRequestJson: string, binaryChunk?: Uint8Array): Promise<string>;
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
		normalizeAccountEmail?(input: string): string;
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
			downloadSinkExecutor: AttachmentDownloadSinkExecutor,
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
	attachmentDownloadSinkExecutorFactory?: (
		runtimeIncarnation: string,
	) => AttachmentDownloadSinkExecutor;
	prepareAttachmentDownloadSinkRuntimeIncarnation?: (
		runtimeIncarnation: string,
	) => Promise<void>;
	commitAttachmentDownloadSinkRuntimeIncarnation?: (
		runtimeIncarnation: string,
	) => Promise<void>;
	runtimeIncarnationIdentity?: () => string;
	/** Trusted host probe; production uses the Worker-global timer and MessageChannel task source. */
	deviceTimerLivenessProbe?: (signal: AbortSignal) => Promise<void>;
	accountLeaseExecutor?: AccountLeaseExecutor;
	loadWasm(): Promise<RuntimeWasm>;
	authClient?: RuntimeAuthClientConfig;
}

type RuntimeCommand =
	| { type: "request"; requestId: string; requestJson: string }
	| { type: "observe"; observationId: string; requestJson: string }
	| { type: "unobserve"; observationId: string }
	| { type: "normalizeAccountEmail"; value: string };

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

/** Proves callback liveness without imposing a host-speed deadline. */
export function probeSystemDeviceTimerLiveness(
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const Timer = globalThis.setTimeout;
		if (typeof Timer !== "function") {
			reject(new Error("Device timer is unavailable"));
			return;
		}
		let settled = false;
		let handle: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			if (handle !== undefined) globalThis.clearTimeout(handle);
			if (error === undefined) resolve();
			else reject(error);
		};
		const abort = () => finish(new Error("Device timer probe was cancelled"));
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		try {
			handle = Timer(() => finish(), 0);
		} catch {
			finish(new Error("Device timer is unavailable"));
		}
	});
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

/**
 * Whether this command is the whole-Device wipe, and nothing wider.
 *
 * The Runtime denies unknown fields, so `{"type":"wipe","accountId":"x"}` is not a wipe. Matching
 * loosely here would hand a Runtime that never opened to a request the Runtime itself refuses.
 */
function isDeviceWipe(command: RuntimeCommand): boolean {
	if (command.type !== "request") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(command.requestJson);
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null) return false;
	const request = parsed as Record<string, unknown>;
	return request.type === "wipe" && hasExactKeys(request, ["type"]);
}

function parseCommand(value: unknown): RuntimeCommand {
	if (typeof value !== "object" || value === null) {
		throw invalidInput("Runtime commands must be plain objects.");
	}
	const command = value as Record<string, unknown>;
	if (
		command.type === "normalizeAccountEmail" &&
		typeof command.value === "string" &&
		hasExactKeys(command, ["type", "value"])
	) {
		return command as RuntimeCommand;
	}
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
	let startupAbort: AbortController | undefined;
	/**
	 * Device wipes that were accepted but have not taken their hold on the Runtime yet.
	 *
	 * A wipe can only `hold()` the un-opened Runtime after its own `await runtime()` resumes. Every
	 * concurrent request awaits the same cached Runtime task, so a request that resumes first would
	 * otherwise see no holder, retire the Runtime, and close it under the wipe. Counting the wipe
	 * before it yields keeps its Runtime alive, and keeps a second Runtime from opening over storage
	 * the first one is still destroying.
	 */
	let wipesPending = 0;
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
		const startup = new AbortController();
		startupAbort = startup;
		let started!: Promise<RuntimeIncarnation>;
		started = deps.loadWasm().then(async ({ WebClientRuntime }) => {
			const replicaInvoke = deps.executor.invoke.bind(deps.executor);
			const platformInvoke = deps.platformStorageExecutor.invoke.bind(
				deps.platformStorageExecutor,
			);
			const httpInvoke = deps.httpExecutor.invoke.bind(deps.httpExecutor);
			const httpCancel = deps.httpExecutor.cancel.bind(deps.httpExecutor);
			let created: WebClientRuntimeLike;
			let attachmentDownloadRuntimeIncarnation: string | undefined;
			let closeCreatedTask: Promise<void> | undefined;
			const closeCreated = (): Promise<void> => {
				closeCreatedTask ??= Promise.resolve().then(() => created.close());
				return closeCreatedTask;
			};
			let lifecycleFailed = false;
			let incarnation: RuntimeIncarnation | undefined;
			if (deps.authClient !== undefined) {
				const runtimeIncarnation =
					deps.runtimeIncarnationIdentity?.() ?? globalThis.crypto.randomUUID();
				attachmentDownloadRuntimeIncarnation = runtimeIncarnation;
				if (
					runtimeIncarnation.length === 0 ||
					runtimeIncarnation.length > 128 ||
					!/^[A-Za-z0-9._~-]+$/.test(runtimeIncarnation)
				)
					throw attachmentPreparationFailed();
				const createConfiguredRuntime =
					WebClientRuntime.withConfiguredAttachmentMovePreparation;
				if (
					createConfiguredRuntime === undefined ||
					deps.attachmentArtifactExecutor === undefined ||
					deps.binaryTransferExecutorFactory === undefined ||
					deps.accountLeaseExecutor === undefined ||
					deps.attachmentDownloadSinkExecutorFactory === undefined ||
					deps.prepareAttachmentDownloadSinkRuntimeIncarnation === undefined ||
					deps.commitAttachmentDownloadSinkRuntimeIncarnation === undefined
				) {
					throw attachmentPreparationFailed();
				}
				let downloadSinkExecutor: AttachmentDownloadSinkExecutor;
				let binaryTransferExecutor: BinaryTransferExecutor;
				try {
					binaryTransferExecutor = deps.binaryTransferExecutorFactory();
				} catch {
					throw attachmentPreparationFailed();
				}
				try {
					downloadSinkExecutor =
						deps.attachmentDownloadSinkExecutorFactory(runtimeIncarnation);
				} catch {
					binaryTransferExecutor.close();
					throw attachmentPreparationFailed();
				}
				try {
					await deps.prepareAttachmentDownloadSinkRuntimeIncarnation(
						runtimeIncarnation,
					);
				} catch {
					binaryTransferExecutor.close();
					throw attachmentPreparationFailed();
				}
				const abortPendingScope = async (): Promise<void> => {
					const response = await downloadSinkExecutor.invoke(
						'{"type":"retireRuntime"}',
					);
					if (response !== '{"type":"retired"}')
						throw attachmentPreparationFailed();
				};
				try {
					await (deps.deviceTimerLivenessProbe?.(startup.signal) ??
						probeSystemDeviceTimerLiveness(startup.signal));
				} catch {
					binaryTransferExecutor.close();
					await abortPendingScope().catch(() => undefined);
					throw attachmentPreparationFailed();
				}
				try {
					created = createConfiguredRuntime.call(
						WebClientRuntime,
						replicaInvoke,
						platformInvoke,
						httpInvoke,
						httpCancel,
						deps.attachmentArtifactExecutor,
						binaryTransferExecutor,
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
						downloadSinkExecutor,
					);
				} catch {
					binaryTransferExecutor.close();
					await abortPendingScope().catch(() => undefined);
					throw attachmentPreparationFailed();
				}
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
				if (lifecycleFailed) {
					await closeCreated().then(
						() => undefined,
						() => undefined,
					);
					return await rejectLifecycleFailure();
				}
				let holders = 0;
				incarnation.wedged = {
					error,
					hold: () => {
						holders += 1;
					},
					release: () => {
						holders -= 1;
					},
					retire: async () => {
						if (holders > 0 || wipesPending > 0) return;
						if (runtimeTask === started) runtimeTask = undefined;
						// Dropping the cached task alone would let the next request build and open a
						// second Runtime over storage this one is still writing, because `close()`
						// keeps writing after every in-process lock is gone. Hold the rebuild behind
						// the close, exactly as a failed lifecycle does.
						let barrier!: Promise<void>;
						const reopen = () => {
							if (restartBarrier === barrier) restartBarrier = undefined;
						};
						barrier = closeCreated().then(reopen, () => {
							// A close that rejects leaves the Attachment Move preparation lifecycle in
							// an unknown state, so no later request may reuse this worker. Decide that
							// here, before anyone waiting on the barrier resumes.
							if (deps.authClient !== undefined) {
								terminalFailure ??= attachmentPreparationFailed();
							}
							reopen();
						});
						restartBarrier = barrier;
						// The barrier never rejects. A caller that this close did not poison should get
						// a fresh Runtime, not the close's error.
						await barrier;
					},
				};
				return incarnation;
			}
			if (lifecycleFailed) return await rejectLifecycleFailure();
			if (attachmentDownloadRuntimeIncarnation !== undefined) {
				try {
					await deps.commitAttachmentDownloadSinkRuntimeIncarnation?.(
						attachmentDownloadRuntimeIncarnation,
					);
				} catch {
					const failure = attachmentPreparationFailed();
					try {
						await closeCreated();
					} catch {
						terminalFailure = failure;
					}
					throw failure;
				}
			}
			return incarnation;
		});
		runtimeTask = started;
		void started.then(
			() => {
				if (startupAbort === startup) startupAbort = undefined;
			},
			() => {
				if (startupAbort === startup) startupAbort = undefined;
			},
		);
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
			if (command.type === "normalizeAccountEmail") {
				if (signal.aborted)
					throw invalidInput("Account email normalization was cancelled.");
				const wasm = await deps.loadWasm();
				const normalize = wasm.WebClientRuntime.normalizeAccountEmail;
				if (normalize === undefined) {
					throw invalidInput(
						"The Rust Account email normalizer is unavailable.",
					);
				}
				return normalize.call(wasm.WebClientRuntime, command.value);
			}
			// A wipe can only hold the Runtime after `runtime()` resumes it. Claim its interest here,
			// before the first `await`, where no other request's continuation can run.
			let counted = isDeviceWipe(command);
			if (counted) wipesPending += 1;
			const uncount = () => {
				if (!counted) return;
				counted = false;
				wipesPending -= 1;
			};
			try {
				const incarnation = await runtime();
				if (incarnation.failed) return await rejectLifecycleFailure();
				const wedged = incarnation.wedged;
				// `counted` still carries `isDeviceWipe(command)` here: nothing has called `uncount`
				// yet, and the command cannot change. Reuse it rather than parse the request again.
				if (wedged !== undefined && !counted) {
					await wedged.retire();
					if (terminalFailure !== undefined) throw terminalFailure;
					throw wedged.error;
				}
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
				wedged?.hold();
				// The hold now keeps this Runtime alive, so the wipe must stop blocking its own retire.
				uncount();
				try {
					return await ready.request_json(
						command.requestId,
						command.requestJson,
					);
				} finally {
					signal.removeEventListener("abort", cancel);
					if (wedged !== undefined) {
						// The wipe destroyed the storage that `open()` choked on, so the next request should
						// build a Runtime that can open. Retire this one either way: an incomplete wipe is
						// retried against a fresh Runtime.
						wedged.release();
						// A retire that sets `terminalFailure` does not take the wipe's answer away. The
						// wipe finished; only the worker is spent. Later requests carry that failure, so
						// this stays deliberately asymmetric with the non-wipe path above, which throws it.
						await wedged.retire();
					}
				}
			} finally {
				uncount();
			}
		},
		close() {
			if (closeTask === undefined) {
				closing = true;
				startupAbort?.abort();
				closeTask =
					terminalFailure === undefined
						? restartBarrier !== undefined
							? restartBarrier.then(() => {
									// The barrier hides a failed close from `runtime()` so a caller it did not
									// poison gets a fresh Runtime. `close()` owns the shutdown, so it must
									// report that failure instead of a clean shutdown that never happened.
									if (terminalFailure !== undefined) throw terminalFailure;
								})
							: runtimeTask === undefined
								? Promise.resolve()
								: runtimeTask.then(
										(ready) =>
											closeRuntime(ready.runtime).catch((error: unknown) => {
												// A Runtime that never opened escalates a failed close the same way
												// startup does, so the redacted terminal failure stays authoritative.
												if (ready.wedged === undefined) throw error;
												if (deps.authClient !== undefined) {
													terminalFailure ??= attachmentPreparationFailed();
												}
												throw terminalFailure ?? error;
											}),
										() => {
											if (terminalFailure !== undefined) throw terminalFailure;
										},
									)
						: Promise.reject(terminalFailure);
				void closeTask.catch(() => undefined);
			}
			return closeTask;
		},
	};
}

export interface WorkerRuntime {
	normalizeAccountEmail(value: string): Promise<string>;
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
		normalizeAccountEmail(value) {
			return channel.request<string>({ type: "normalizeAccountEmail", value });
		},
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
