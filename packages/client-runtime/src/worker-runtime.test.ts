import { describe, expect, test } from "bun:test";
import {
	createRuntimeWorkerService,
	createWorkerRuntime,
	type RuntimeWasm,
} from "./worker-runtime";

/** Lets every pending microtask run, so anything that was going to start has started. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const authenticatedDownloadSinkPorts = {
	prepareAttachmentDownloadSinkRuntimeIncarnation: async () => undefined,
	attachmentDownloadSinkExecutorFactory: () => ({
		invoke: async (request: string) =>
			JSON.stringify({
				type:
					JSON.parse(request).type === "retireRuntime"
						? "retired"
						: "discarded",
			}),
	}),
	commitAttachmentDownloadSinkRuntimeIncarnation: async () => undefined,
	attachmentUploadSourceExecutorFactory: () => ({
		invoke: async (request: string) => ({
			controlResponseJson: JSON.stringify({
				type:
					JSON.parse(request).type === "retireRuntime"
						? "retired"
						: "invariantViolation",
			}),
		}),
	}),
	vaultImageArtifactExecutor: {
		invoke: async (request: string) => ({
			controlResponseJson: JSON.stringify({
				type: JSON.parse(request).type === "wipe" ? "wiped" : "begun",
			}),
		}),
	},
	vaultImageSourceExecutorFactory: () => ({
		invoke: async (request: string) => ({
			controlResponseJson: JSON.stringify({
				type:
					JSON.parse(request).type === "retireRuntime"
						? "retired"
						: "invariantViolation",
			}),
		}),
	}),
	deviceTimerLivenessProbe: async () => undefined,
};

const unavailableForegroundUploadBinary = {
	beginForegroundUpload: () => {
		throw new Error("foreground Upload is unavailable in this test");
	},
	writeForegroundUpload: async () => undefined,
	finishForegroundUpload: async () => ({ type: "notDispatched" as const }),
	abortForegroundUpload: async () => undefined,
};

class RuntimeDouble {
	readonly cancelled: string[] = [];
	readonly observations = new Map<string, (projectionJson: string) => void>();
	readonly requests: Array<{ requestId: string; requestJson: string }> = [];
	closeCalls = 0;
	openCalls = 0;
	requestResult = Promise.resolve('{"type":"AuthenticationUnavailable"}');

	cancel(requestId: string): void {
		this.cancelled.push(requestId);
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}

	async open(): Promise<void> {
		this.openCalls += 1;
	}

	observe_json(
		observationId: string,
		_requestJson: string,
		callback: (projectionJson: string) => void,
	): void {
		this.observations.set(observationId, callback);
		callback('{"type":"initial"}');
	}

	request_json(requestId: string, requestJson: string): Promise<string> {
		this.requests.push({ requestId, requestJson });
		return this.requestResult;
	}

	unobserve(observationId: string): void {
		this.observations.delete(observationId);
	}
}

function runtimeService(runtime: RuntimeDouble) {
	let persistenceInvocations = 0;
	let platformStorageInvocations = 0;
	const service = createRuntimeWorkerService({
		executor: {
			async invoke() {
				persistenceInvocations += 1;
				return "{}";
			},
		},
		platformStorageExecutor: {
			async invoke() {
				platformStorageInvocations += 1;
				return "{}";
			},
		},
		httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
		loadWasm: async () =>
			({
				WebClientRuntime: {
					withExecutors: () => runtime,
				},
			}) as unknown as RuntimeWasm,
	});
	return {
		service,
		persistenceInvocations: () => persistenceInvocations,
		platformStorageInvocations: () => platformStorageInvocations,
	};
}

describe("Runtime worker service", () => {
	test("normalizes Account email through the Rust WASM facade", async () => {
		const runtime = new RuntimeDouble();
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			loadWasm: async () => ({
				WebClientRuntime: {
					normalizeAccountEmail(value: string) {
						expect(value).toBe("  ＭＵ̈ＬＬＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ  ");
						return "müller@example.com";
					},
					withExecutors: () => runtime,
				},
			}),
		});

		expect(
			await service.request(
				{
					type: "normalizeAccountEmail",
					value: "  ＭＵ̈ＬＬＥＲ＠ＥＸＡＭＰＬＥ．ＣＯＭ  ",
				},
				new AbortController().signal,
				() => undefined,
			),
		).toBe("müller@example.com");
	});
	test("passes every serialized executor and opens once before serving commands", async () => {
		const runtime = new RuntimeDouble();
		const calls: string[] = [];
		let replicaInvoke: ((requestJson: string) => Promise<string>) | undefined;
		let platformInvoke: ((requestJson: string) => Promise<string>) | undefined;
		let httpInvoke: ((requestJson: string) => Promise<string>) | undefined;
		let httpCancel: ((dispatchId: string) => void) | undefined;
		const service = createRuntimeWorkerService({
			executor: {
				async invoke(requestJson) {
					calls.push(`replica:${requestJson}`);
					return "replica-result";
				},
			},
			platformStorageExecutor: {
				async invoke(requestJson) {
					calls.push(`platform:${requestJson}`);
					return "platform-result";
				},
			},
			httpExecutor: {
				async invoke(requestJson) {
					calls.push(`http:${requestJson}`);
					return "http-result";
				},
				cancel(dispatchId) {
					calls.push(`cancel:${dispatchId}`);
				},
			},
			loadWasm: async () => ({
				WebClientRuntime: {
					withExecutors(replica, platform, invokeHttp, cancelHttp) {
						replicaInvoke = replica;
						platformInvoke = platform;
						httpInvoke = invokeHttp;
						httpCancel = cancelHttp;
						return runtime;
					},
				},
			}),
		});

		await Promise.all([
			service.request(
				{ type: "request", requestId: "one", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
			service.request(
				{ type: "request", requestId: "two", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		]);

		expect(runtime.openCalls).toBe(1);
		expect(replicaInvoke).toBeFunction();
		expect(platformInvoke).toBeFunction();
		expect(httpInvoke).toBeFunction();
		expect(httpCancel).toBeFunction();
		expect(await replicaInvoke?.('{"type":"read"}')).toBe("replica-result");
		expect(await platformInvoke?.('{"type":"get"}')).toBe("platform-result");
		expect(await httpInvoke?.('{"dispatchId":"one"}')).toBe("http-result");
		httpCancel?.("one");
		expect(calls).toEqual([
			'replica:{"type":"read"}',
			'platform:{"type":"get"}',
			'http:{"dispatchId":"one"}',
			"cancel:one",
		]);
	});

	test("authenticated production uses the Attachment preparation constructor and fixed ports", async () => {
		const runtime = new RuntimeDouble();
		const readiness: string[] = [];
		runtime.open = async () => {
			runtime.openCalls += 1;
			readiness.push("open");
		};
		runtime.request_json = async () => {
			readiness.push("request");
			return "{}";
		};
		const configured: unknown[] = [];
		let legacyConfiguredCalls = 0;
		let constructorThis: unknown;
		const artifactExecutor = {
			invoke: async () => ({ controlResponseJson: "{}" }),
		};
		const binaryExecutor = {
			...unavailableForegroundUploadBinary,
			invoke: async () => ({ controlResponseJson: "{}" }),
			close: () => undefined,
		};
		const accountLeaseExecutor = { acquire: async () => null };
		let configuredDownloadSink: unknown;
		let configuredUploadSource: unknown;
		let configuredTakeUploadSourceBinary: unknown;
		const configuredService = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: artifactExecutor,
			binaryTransferExecutorFactory: () => binaryExecutor,
			accountLeaseExecutor,
			...authenticatedDownloadSinkPorts,
			runtimeIncarnationIdentity: () => "runtime-fixed",
			prepareAttachmentDownloadSinkRuntimeIncarnation: async (identity) => {
				expect(identity).toBe("runtime-fixed");
				readiness.push("prepare");
			},
			commitAttachmentDownloadSinkRuntimeIncarnation: async (identity) => {
				expect(identity).toBe("runtime-fixed");
				readiness.push("activate");
			},
			authClient: {
				clientId: "bittery-web",
				platform: "web",
				version: "0.5.2",
			},
			loadWasm: async () =>
				({
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredExecutors() {
							legacyConfiguredCalls += 1;
							return runtime;
						},
						withConfiguredAttachmentMovePreparation(
							this: unknown,
							_replica: unknown,
							_platform: unknown,
							_http: unknown,
							_cancel: unknown,
							artifact: unknown,
							binary: unknown,
							lease: unknown,
							clientId: string,
							platform: string,
							version: string,
							lifecycleError: unknown,
							downloadSink: unknown,
							uploadSource: unknown,
							takeUploadSourceBinary: unknown,
						) {
							readiness.push("construct");
							constructorThis = this;
							configured.push(
								artifact,
								binary,
								lease,
								clientId,
								platform,
								version,
								lifecycleError,
							);
							configuredDownloadSink = downloadSink;
							configuredUploadSource = uploadSource;
							configuredTakeUploadSourceBinary = takeUploadSourceBinary;
							return runtime;
						},
					},
				}) as unknown as RuntimeWasm,
		});
		await configuredService.request(
			{ type: "request", requestId: "auth", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		expect(Reflect.ownKeys(configured[0] as object)).toEqual(["invoke"]);
		expect(configured[0]).not.toBe(artifactExecutor);
		expect(configured[1]).toBe(binaryExecutor);
		expect(Reflect.ownKeys(configured[2] as object)).toEqual(["acquire"]);
		expect(configured[2]).not.toBe(accountLeaseExecutor);
		expect(configured.slice(3, 6)).toEqual(["bittery-web", "web", "0.5.2"]);
		expect(configured[6]).toBeFunction();
		expect(Reflect.ownKeys(configuredDownloadSink as object)).toEqual([
			"invoke",
		]);
		expect(Reflect.ownKeys(configuredUploadSource as object)).toEqual([
			"invoke",
		]);
		expect(configuredTakeUploadSourceBinary).toBeFunction();
		let getterCalls = 0;
		const hostile = new Uint8Array([9, 8]);
		Object.defineProperty(hostile, "byteLength", {
			get() {
				getterCalls += 1;
				throw new Error("hostile byteLength getter");
			},
		});
		expect(
			(
				configuredTakeUploadSourceBinary as (
					value: unknown,
				) => ArrayBuffer | undefined
			)(hostile),
		).toBeUndefined();
		expect(getterCalls).toBe(0);
		expect(Uint8Array.prototype.slice.call(hostile)).toEqual(new Uint8Array(2));
		expect(legacyConfiguredCalls).toBe(0);
		expect(constructorThis).toBeDefined();
		expect(readiness).toEqual([
			"prepare",
			"construct",
			"open",
			"activate",
			"request",
		]);
	});

	for (const missing of ["factory", "activation"] as const) {
		test(`authenticated construction rejects a missing Download sink ${missing} before Runtime construction`, async () => {
			const runtime = new RuntimeDouble();
			let constructions = 0;
			const service = createRuntimeWorkerService({
				executor: { invoke: async () => "{}" },
				platformStorageExecutor: { invoke: async () => "{}" },
				httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
				attachmentArtifactExecutor: {
					invoke: async () => ({ controlResponseJson: "{}" }),
				},
				binaryTransferExecutorFactory: () => ({
					...unavailableForegroundUploadBinary,
					invoke: async () => ({ controlResponseJson: "{}" }),
					close: () => undefined,
				}),
				accountLeaseExecutor: { acquire: async () => null },
				...(missing === "factory"
					? {
							commitAttachmentDownloadSinkRuntimeIncarnation: async () =>
								undefined,
						}
					: {
							attachmentDownloadSinkExecutorFactory: () => ({
								invoke: async () => "{}",
							}),
						}),
				authClient: { clientId: "client", platform: "web", version: "1" },
				loadWasm: async () => ({
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation: () => {
							constructions += 1;
							return runtime;
						},
					},
				}),
			});
			await expect(
				service.request(
					{ type: "request", requestId: missing, requestJson: "{}" },
					new AbortController().signal,
					() => undefined,
				),
			).rejects.toMatchObject({
				code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
			});
			expect(constructions).toBe(0);
			expect(runtime.openCalls).toBe(0);
			expect(runtime.closeCalls).toBe(0);
		});
	}

	test("authenticated constructor failure closes the created binary executor before any open or request", async () => {
		const runtime = new RuntimeDouble();
		let binaryCloses = 0;
		let releaseBinaryClose!: () => void;
		const binaryCloseHeld = new Promise<void>((resolve) => {
			releaseBinaryClose = resolve;
		});
		let uploadRetirements = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: async () => {
					binaryCloses += 1;
					await binaryCloseHeld;
				},
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			attachmentUploadSourceExecutorFactory: () => ({
				invoke: async (request) => {
					if (JSON.parse(request).type === "retireRuntime")
						uploadRetirements += 1;
					return { controlResponseJson: '{"type":"retired"}' };
				},
			}),
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => ({
				WebClientRuntime: {
					withExecutors: () => runtime,
					withConfiguredAttachmentMovePreparation: () => {
						throw new Error("timer unavailable");
					},
				},
			}),
		});
		let rejected = false;
		const failedStartup = service
			.request(
				{ type: "request", requestId: "construction", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => {
				rejected = true;
				throw error;
			});
		while (binaryCloses < 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
		expect(rejected).toBe(false);
		releaseBinaryClose();
		await expect(failedStartup).rejects.toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
		});
		expect(binaryCloses).toBe(1);
		expect(uploadRetirements).toBe(1);
		expect(runtime.openCalls).toBe(0);
		expect(runtime.requests).toHaveLength(0);
	});

	test("failed sink activation closes the unexposed Runtime and retries cleanup with a fresh scope", async () => {
		const runtimes = [new RuntimeDouble(), new RuntimeDouble()];
		const activations: string[] = [];
		const lifecycle: string[] = [];
		const pending = new Set<string>();
		let loads = 0;
		let identities = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			prepareAttachmentDownloadSinkRuntimeIncarnation: async (identity) => {
				pending.add(identity);
				lifecycle.push(`prepare:${identity}`);
			},
			attachmentDownloadSinkExecutorFactory: (identity) => ({
				invoke: async (request) => {
					if (
						JSON.parse(request).type !== "retireRuntime" ||
						!pending.has(identity)
					)
						return '{"type":"invariantViolation"}';
					pending.delete(identity);
					lifecycle.push(`retire:${identity}`);
					return '{"type":"retired"}';
				},
			}),
			authClient: { clientId: "client", platform: "web", version: "1" },
			runtimeIncarnationIdentity: () => `scope-${++identities}`,
			commitAttachmentDownloadSinkRuntimeIncarnation: async (identity) => {
				activations.push(identity);
				lifecycle.push(`commit:${identity}`);
				if (activations.length === 1) throw new Error("discard failed");
				pending.delete(identity);
			},
			loadWasm: async () => {
				const runtime = runtimes[loads++];
				if (runtime === undefined) throw new Error("unexpected reconstruction");
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica: unknown,
							_platform: unknown,
							_http: unknown,
							_cancel: unknown,
							_artifact: unknown,
							_binary: unknown,
							_lease: unknown,
							_client: unknown,
							_platformName: unknown,
							_version: unknown,
							_lifecycle: unknown,
							sink: { invoke(request: string): Promise<string> },
						) {
							runtime.close = async () => {
								runtime.closeCalls += 1;
								await sink.invoke('{"type":"retireRuntime"}');
							};
							return runtime;
						},
					},
				} as unknown as RuntimeWasm;
			},
		});
		const command = {
			type: "request" as const,
			requestId: "download",
			requestJson: "{}",
		};
		await expect(
			service.request(command, new AbortController().signal, () => undefined),
		).rejects.toMatchObject({ code: "ATTACHMENT_MOVE_PREPARATION_FAILED" });
		expect(runtimes[0]?.requests).toHaveLength(0);
		expect(runtimes[0]?.closeCalls).toBe(1);
		await service.request(
			command,
			new AbortController().signal,
			() => undefined,
		);
		expect(activations).toEqual(["scope-1", "scope-2"]);
		expect(lifecycle).toEqual([
			"prepare:scope-1",
			"commit:scope-1",
			"retire:scope-1",
			"prepare:scope-2",
			"commit:scope-2",
		]);
		expect(pending.size).toBe(0);
		expect(identities).toBe(2);
		expect(runtimes[1]?.requests).toHaveLength(1);
	});

	test("closes a failed preparation runner, surfaces one stable error, and reconstructs", async () => {
		const runtimes = Array.from({ length: 8 }, () => new RuntimeDouble());
		const lifecycleErrors: Array<(errorJson: string) => void> = [];
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => {
				const runtime = runtimes[loads++];
				if (runtime === undefined) throw new Error("unexpected extra restart");
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica,
							_platform,
							_http,
							_cancel,
							_artifact,
							_binary,
							_lease,
							_clientId,
							_platformName,
							_version,
							lifecycleError,
						) {
							lifecycleErrors.push(lifecycleError);
							return runtime;
						},
					},
				};
			},
		});

		await service.request(
			{ type: "request", requestId: "initial", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		for (let attempt = 0; attempt < 7; attempt += 1) {
			lifecycleErrors[attempt]?.(
				'{"code":"SECRET_BACKTRACE","message":"https://signed.example/credential"}',
			);
			await expect(
				service.request(
					{
						type: "request",
						requestId: `observes-failure-${attempt}`,
						requestJson: "{}",
					},
					new AbortController().signal,
					() => undefined,
				),
			).rejects.toMatchObject({
				code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
				message: "Attachment Move preparation lifecycle failed.",
			});
			await service.request(
				{
					type: "request",
					requestId: `restart-${attempt}`,
					requestJson: "{}",
				},
				new AbortController().signal,
				() => undefined,
			);
		}
		expect(runtimes.slice(0, 7).map(({ closeCalls }) => closeCalls)).toEqual(
			Array.from({ length: 7 }, () => 1),
		);
		expect(loads).toBe(8);
		expect(runtimes[7]?.openCalls).toBe(1);
	});

	test("reconstruction receives a fresh live binary executor incarnation", async () => {
		const runtimes = [new RuntimeDouble(), new RuntimeDouble()];
		const lifecycleErrors: Array<(errorJson: string) => void> = [];
		const binaries: Array<{
			closed: boolean;
			close(): void;
			invoke(): Promise<{ controlResponseJson: string }>;
		}> = [];
		let loads = 0;
		let factoryCalls = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => {
				factoryCalls += 1;
				const binary = {
					...unavailableForegroundUploadBinary,
					closed: false,
					close() {
						binary.closed = true;
					},
					invoke: async () => ({ controlResponseJson: "{}" }),
				};
				return binary;
			},
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => ({
				WebClientRuntime: {
					withExecutors: () => {
						throw new Error("unexpected legacy constructor");
					},
					withConfiguredAttachmentMovePreparation(
						_replica,
						_platform,
						_http,
						_cancel,
						_artifact,
						binary,
						_lease,
						_clientId,
						_platformName,
						_version,
						onLifecycleError,
					) {
						const runtime = runtimes[loads];
						if (runtime === undefined) throw new Error("unexpected restart");
						loads += 1;
						const received = binary as unknown as (typeof binaries)[number];
						binaries.push(received);
						lifecycleErrors.push(onLifecycleError);
						runtime.close = async () => {
							runtime.closeCalls += 1;
							received.close();
						};
						return runtime;
					},
				},
			}),
		});

		await service.request(
			{ type: "request", requestId: "first", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		lifecycleErrors[0]?.("{}");
		await service
			.request(
				{ type: "request", requestId: "failure", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch(() => undefined);
		await service.request(
			{ type: "request", requestId: "replacement", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);

		expect(factoryCalls).toBe(2);
		expect(binaries).toHaveLength(2);
		expect(binaries[0]?.closed).toBe(true);
		expect(binaries[1]?.closed).toBe(false);
		expect(binaries[1]).not.toBe(binaries[0]);
	});

	test("does not serve through a runner that fails synchronously during construction", async () => {
		const failed = new RuntimeDouble();
		const replacement = new RuntimeDouble();
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => {
				const runtime = loads++ === 0 ? failed : replacement;
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica,
							_platform,
							_http,
							_cancel,
							_artifact,
							_binary,
							_lease,
							_clientId,
							_platformName,
							_version,
							lifecycleError,
						) {
							if (runtime === failed) lifecycleError('{"code":"secret"}');
							return runtime;
						},
					},
				};
			},
		});

		await expect(
			service.request(
				{ type: "request", requestId: "failed", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
			message: "Attachment Move preparation lifecycle failed.",
		});
		expect(failed.requests).toHaveLength(0);
		expect(failed.openCalls).toBe(0);
		expect(failed.closeCalls).toBe(1);

		await service.request(
			{ type: "request", requestId: "replacement", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		expect(loads).toBe(2);
		expect(replacement.requests).toHaveLength(1);
	});

	test("does not serve a cached incarnation that fails before the request continuation", async () => {
		const failed = new RuntimeDouble();
		const replacement = new RuntimeDouble();
		let lifecycleError!: (errorJson: string) => void;
		let loads = 0;
		const moduleFor = (runtime: RuntimeDouble): RuntimeWasm => ({
			WebClientRuntime: {
				withExecutors: () => runtime,
				withConfiguredAttachmentMovePreparation(
					_replica,
					_platform,
					_http,
					_cancel,
					_artifact,
					_binary,
					_lease,
					_clientId,
					_platformName,
					_version,
					onLifecycleError,
				) {
					lifecycleError = onLifecycleError;
					return runtime;
				},
			},
		});
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: () => {
				const runtime = loads++ === 0 ? failed : replacement;
				const module = moduleFor(runtime);
				return {
					// biome-ignore lint/suspicious/noThenProperty: the pre-registered reaction creates the exact promise-continuation race under test
					then<TResult1 = RuntimeWasm, TResult2 = never>(
						onFulfilled?:
							| ((value: RuntimeWasm) => TResult1 | PromiseLike<TResult1>)
							| null,
						onRejected?:
							| ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
							| null,
					) {
						const started = Promise.resolve(module).then(
							onFulfilled,
							onRejected,
						);
						if (runtime === failed) {
							void started.then(() => lifecycleError("{}"));
						}
						return started;
					},
				} as Promise<RuntimeWasm>;
			},
		});

		const failure = await service
			.request(
				{ type: "request", requestId: "failed-cached", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);

		expect(failed.requests).toHaveLength(0);
		expect(failure).toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
			message: "Attachment Move preparation lifecycle failed.",
		});
		await service.request(
			{ type: "request", requestId: "replacement", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		expect(loads).toBe(2);
		expect(replacement.requests).toHaveLength(1);
	});

	test("close during a lifecycle restart barrier closes the failed runner once", async () => {
		const runtime = new RuntimeDouble();
		let lifecycleError!: (errorJson: string) => void;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => ({
				WebClientRuntime: {
					withExecutors: () => runtime,
					withConfiguredAttachmentMovePreparation(
						_replica,
						_platform,
						_http,
						_cancel,
						_artifact,
						_binary,
						_lease,
						_clientId,
						_platformName,
						_version,
						onLifecycleError,
					) {
						lifecycleError = onLifecycleError;
						return runtime;
					},
				},
			}),
		});

		await service.request(
			{ type: "request", requestId: "start", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		lifecycleError("{}");
		await service.close();

		expect(runtime.closeCalls).toBe(1);
	});

	test("a lifecycle failure racing a rejected open closes the created runner once", async () => {
		const runtime = new RuntimeDouble();
		let lifecycleError!: (errorJson: string) => void;
		runtime.open = async () => {
			runtime.openCalls += 1;
			lifecycleError('{"message":"https://signed.example/secret"}');
			throw new Error("open exposed an internal failure");
		};
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => ({
				WebClientRuntime: {
					withExecutors: () => runtime,
					withConfiguredAttachmentMovePreparation(
						_replica,
						_platform,
						_http,
						_cancel,
						_artifact,
						_binary,
						_lease,
						_clientId,
						_platformName,
						_version,
						onLifecycleError,
					) {
						lifecycleError = onLifecycleError;
						return runtime;
					},
				},
			}),
		});

		const failure = await service
			.request(
				{ type: "request", requestId: "raced-open", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);

		expect(runtime.closeCalls).toBe(1);
		expect(failure).toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
			message: "Attachment Move preparation lifecycle failed.",
		});
	});

	test("a lifecycle close failure stays terminal and redacted without reconstructing", async () => {
		const runtime = new RuntimeDouble();
		const secretCloseFailure = new Error(
			"https://signed.example/secret?credential=plaintext",
		);
		runtime.close = async () => {
			runtime.closeCalls += 1;
			throw secretCloseFailure;
		};
		let lifecycleError!: (errorJson: string) => void;
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => {
				loads += 1;
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica,
							_platform,
							_http,
							_cancel,
							_artifact,
							_binary,
							_lease,
							_clientId,
							_platformName,
							_version,
							onLifecycleError,
						) {
							lifecycleError = onLifecycleError;
							return runtime;
						},
					},
				};
			},
		});

		await service.request(
			{ type: "request", requestId: "start", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		lifecycleError('{"message":"another signed secret"}');
		const closeFailure = service.close().catch((error: unknown) => error);
		const firstFailure = await service
			.request(
				{ type: "request", requestId: "terminal-1", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);
		const secondFailure = await service
			.request(
				{ type: "request", requestId: "terminal-2", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);
		const observedCloseFailure = await closeFailure;
		const repeatedCloseFailure = await service
			.close()
			.catch((error: unknown) => error);

		for (const failure of [
			firstFailure,
			secondFailure,
			observedCloseFailure,
			repeatedCloseFailure,
		]) {
			expect(failure).toMatchObject({
				code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
				message: "Attachment Move preparation lifecycle failed.",
			});
			expect(String(failure)).not.toContain("signed.example");
			expect(String(failure)).not.toContain("credential");
		}
		expect(runtime.closeCalls).toBe(1);
		expect(runtime.openCalls).toBe(1);
		expect(loads).toBe(1);
	});

	test("authenticated open and cleanup rejection stays terminal and redacted", async () => {
		const runtime = new RuntimeDouble();
		runtime.open = async () => {
			runtime.openCalls += 1;
			throw new Error("open leaked https://signed.example/open-secret");
		};
		runtime.close = async () => {
			runtime.closeCalls += 1;
			throw new Error("close leaked credential=close-secret");
		};
		let loads = 0;
		let activations = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			commitAttachmentDownloadSinkRuntimeIncarnation: async () => {
				activations += 1;
			},
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => {
				loads += 1;
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation: () => runtime,
					},
				};
			},
		});

		const firstFailure = await service
			.request(
				{ type: "request", requestId: "open-failure", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);
		const secondFailure = await service
			.request(
				{ type: "request", requestId: "terminal", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);
		const closeFailure = await service.close().catch((error: unknown) => error);

		for (const failure of [firstFailure, secondFailure, closeFailure]) {
			expect(failure).toMatchObject({
				code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
				message: "Attachment Move preparation lifecycle failed.",
			});
			expect(String(failure)).not.toContain("signed.example");
			expect(String(failure)).not.toContain("credential");
		}
		expect(runtime.openCalls).toBe(1);
		expect(runtime.closeCalls).toBe(1);
		expect(loads).toBe(1);
		expect(activations).toBe(0);
	});

	test("close racing authenticated open and cleanup rejection stays terminal and redacted", async () => {
		const runtime = new RuntimeDouble();
		let rejectOpen!: (error: unknown) => void;
		let openStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			openStarted = resolve;
		});
		runtime.open = () => {
			runtime.openCalls += 1;
			openStarted();
			return new Promise<void>((_resolve, reject) => {
				rejectOpen = reject;
			});
		};
		runtime.close = async () => {
			runtime.closeCalls += 1;
			throw new Error("cleanup leaked credential=close-secret");
		};
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () => {
				loads += 1;
				return {
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation: () => runtime,
					},
				};
			},
		});

		const requestFailure = service
			.request(
				{ type: "request", requestId: "pending-open", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);
		await started;
		const closeFailure = service.close().catch((error: unknown) => error);
		rejectOpen(new Error("open leaked https://signed.example/open-secret"));

		const failures = [
			await requestFailure,
			await closeFailure,
			await service.close().catch((error: unknown) => error),
			await service
				.request(
					{ type: "request", requestId: "terminal", requestJson: "{}" },
					new AbortController().signal,
					() => undefined,
				)
				.catch((error: unknown) => error),
		];
		for (const failure of failures) {
			expect(failure).toMatchObject({
				code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
				message: "Attachment Move preparation lifecycle failed.",
			});
			expect(String(failure)).not.toContain("signed.example");
			expect(String(failure)).not.toContain("credential");
		}
		expect(runtime.openCalls).toBe(1);
		expect(runtime.closeCalls).toBe(1);
		expect(loads).toBe(1);
	});

	test("awaits open before request and closes safely while startup is pending", async () => {
		let finishOpen!: () => void;
		const opened = new Promise<void>((resolve) => {
			finishOpen = resolve;
		});
		const runtime = new RuntimeDouble();
		runtime.open = async () => {
			runtime.openCalls += 1;
			await opened;
		};
		const { service } = runtimeService(runtime);
		const request = service.request(
			{ type: "observe", observationId: "pending", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(runtime.observations.size).toBe(0);

		const close = service.close();
		finishOpen();
		await expect(request).rejects.toMatchObject({ code: "closed" });
		await close;

		expect(runtime.openCalls).toBe(1);
		expect(runtime.closeCalls).toBe(1);
		expect(runtime.observations.size).toBe(0);
	});

	test("retries startup after a failed open instead of memoizing the rejection", async () => {
		const failed = new RuntimeDouble();
		failed.open = async () => {
			failed.openCalls += 1;
			throw new Error("first startup failed");
		};
		const recovered = new RuntimeDouble();
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			loadWasm: async () => {
				const runtime = loads++ === 0 ? failed : recovered;
				return {
					WebClientRuntime: { withExecutors: () => runtime },
				};
			},
		});

		await expect(
			service.request(
				{ type: "request", requestId: "first", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toThrow("first startup failed");
		expect(failed.closeCalls).toBe(1);

		expect(
			await service.request(
				{ type: "request", requestId: "retry", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).toBe('{"type":"AuthenticationUnavailable"}');
		expect(loads).toBe(2);
		expect(recovered.openCalls).toBe(1);
	});

	test("close succeeds idempotently when a concurrent open fails", async () => {
		let rejectOpen!: (error: Error) => void;
		const opening = new Promise<void>((_resolve, reject) => {
			rejectOpen = reject;
		});
		const runtime = new RuntimeDouble();
		runtime.open = async () => {
			runtime.openCalls += 1;
			await opening;
		};
		const { service } = runtimeService(runtime);
		const command = service.request(
			{ type: "request", requestId: "opening", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		for (let turn = 0; runtime.openCalls === 0 && turn < 8; turn += 1) {
			await Promise.resolve();
		}

		const firstClose = service.close();
		const repeatedClose = service.close();
		expect(repeatedClose).toBe(firstClose);
		rejectOpen(new Error("startup failed while closing"));

		await expect(command).rejects.toThrow("startup failed while closing");
		await expect(firstClose).resolves.toBeUndefined();
		expect(runtime.closeCalls).toBe(1);
		await expect(
			service.request(
				{ type: "request", requestId: "late", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toMatchObject({ code: "closed" });
	});

	test("wipes a Device whose open cannot succeed", async () => {
		const wedged = new RuntimeDouble();
		wedged.requestResult = Promise.resolve(
			'{"type":"teardown","scope":{"type":"device"},"status":"complete","failures":[]}',
		);
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		const { service } = runtimeService(wedged);

		const wiped = await service.request(
			{ type: "request", requestId: "wipe", requestJson: '{"type":"wipe"}' },
			new AbortController().signal,
			() => undefined,
		);

		expect(wiped).toBe(
			'{"type":"teardown","scope":{"type":"device"},"status":"complete","failures":[]}',
		);
		expect(wedged.requests).toEqual([
			{ requestId: "wipe", requestJson: '{"type":"wipe"}' },
		]);
	});

	test("retires the wedged Runtime after a wipe so the next request opens a fresh one", async () => {
		const wedged = new RuntimeDouble();
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		const recovered = new RuntimeDouble();
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			loadWasm: async () => {
				const runtime = loads++ === 0 ? wedged : recovered;
				return {
					WebClientRuntime: { withExecutors: () => runtime },
				} as unknown as RuntimeWasm;
			},
		});

		await service.request(
			{ type: "request", requestId: "wipe", requestJson: '{"type":"wipe"}' },
			new AbortController().signal,
			() => undefined,
		);
		expect(wedged.closeCalls).toBe(1);

		expect(
			await service.request(
				{ type: "request", requestId: "after-wipe", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).toBe('{"type":"AuthenticationUnavailable"}');
		expect(loads).toBe(2);
		expect(recovered.openCalls).toBe(1);
		expect(recovered.requests).toEqual([
			{ requestId: "after-wipe", requestJson: "{}" },
		]);
	});

	const wipeOutcome =
		'{"type":"teardown","scope":{"type":"device"},"status":"complete","failures":[]}';

	/**
	 * Puts an observation and a Device wipe on one wedged Runtime, with a wipe that stays in flight.
	 *
	 * Both requests await the same cached Runtime task, so the call order decides which continuation
	 * resumes first. `first` selects that order: the wipe must survive either one.
	 */
	async function wedgedWipeContention(first: "observe" | "wipe") {
		const wedged = new RuntimeDouble();
		const events: string[] = [];
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		wedged.close = async () => {
			wedged.closeCalls += 1;
			events.push("close");
		};
		let finishWipe!: () => void;
		wedged.requestResult = new Promise<string>((resolve) => {
			finishWipe = () => resolve(wipeOutcome);
		});
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			loadWasm: async () => {
				loads += 1;
				events.push(`load#${loads}`);
				return {
					WebClientRuntime: { withExecutors: () => wedged },
				} as unknown as RuntimeWasm;
			},
		});
		const observe = () =>
			service.request(
				{ type: "observe", observationId: "status", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			);
		const wipe = () =>
			service.request(
				{ type: "request", requestId: "wipe", requestJson: '{"type":"wipe"}' },
				new AbortController().signal,
				() => undefined,
			);
		let observed: Promise<unknown>;
		let wiped: Promise<unknown>;
		if (first === "observe") {
			observed = observe();
			wiped = wipe();
		} else {
			wiped = wipe();
			observed = observe();
		}
		void observed.catch(() => undefined);
		return {
			events,
			finishWipe,
			loads: () => loads,
			observed,
			request: (requestId: string) =>
				service.request(
					{ type: "request", requestId, requestJson: "{}" },
					new AbortController().signal,
					() => undefined,
				),
			wedged,
			wiped,
		};
	}

	// The bug this protects against depends on which request registers first, so both orders run.
	for (const first of ["observe", "wipe"] as const) {
		test(`a concurrent request may not close the Runtime a wipe is using, ${first} first`, async () => {
			const contention = await wedgedWipeContention(first);

			await expect(contention.observed).rejects.toThrow(
				"active Account has no durable Replica",
			);
			expect(contention.wedged.closeCalls).toBe(0);

			contention.finishWipe();
			expect(await contention.wiped).toBe(wipeOutcome);
			expect(contention.wedged.closeCalls).toBe(1);
			expect(contention.events).toEqual(["load#1", "close"]);
			expect(contention.wedged.requests).toEqual([
				{ requestId: "wipe", requestJson: '{"type":"wipe"}' },
			]);
		});

		test(`no second Runtime opens over the storage a wipe is destroying, ${first} first`, async () => {
			const contention = await wedgedWipeContention(first);
			await expect(contention.observed).rejects.toThrow(
				"active Account has no durable Replica",
			);

			await expect(contention.request("late")).rejects.toThrow(
				"active Account has no durable Replica",
			);
			expect(contention.loads()).toBe(1);
			expect(contention.wedged.openCalls).toBe(1);

			contention.finishWipe();
			expect(await contention.wiped).toBe(wipeOutcome);
			expect(contention.loads()).toBe(1);
		});
	}

	test("only an exact Device wipe may use a Runtime that failed to open", async () => {
		for (const requestJson of [
			'{"type":"wipe","accountId":"account-1"}',
			'{"type":"removeAccount","accountId":"account-1"}',
			'{"type":"wipe"',
		]) {
			const wedged = new RuntimeDouble();
			wedged.open = async () => {
				wedged.openCalls += 1;
				throw new Error("active Account has no durable Replica");
			};
			const { service } = runtimeService(wedged);

			await expect(
				service.request(
					{ type: "request", requestId: "not-a-wipe", requestJson },
					new AbortController().signal,
					() => undefined,
				),
			).rejects.toThrow("active Account has no durable Replica");
			expect(wedged.requests).toEqual([]);
			expect(wedged.closeCalls).toBe(1);
		}
	});

	test("an observation may not use a Runtime that failed to open", async () => {
		const wedged = new RuntimeDouble();
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		const { service } = runtimeService(wedged);

		await expect(
			service.request(
				{ type: "observe", observationId: "status", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toThrow("active Account has no durable Replica");
		expect(wedged.observations.size).toBe(0);
		expect(wedged.closeCalls).toBe(1);
	});

	test("a terminal lifecycle failure refuses a Device wipe", async () => {
		const runtime = new RuntimeDouble();
		runtime.close = async () => {
			runtime.closeCalls += 1;
			throw new Error("close leaked credential=close-secret");
		};
		let lifecycleError!: (errorJson: string) => void;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () =>
				({
					WebClientRuntime: {
						withExecutors: () => runtime,
						withConfiguredAttachmentMovePreparation(
							_replica: unknown,
							_platform: unknown,
							_http: unknown,
							_cancel: unknown,
							_artifact: unknown,
							_binary: unknown,
							_lease: unknown,
							_clientId: unknown,
							_platformName: unknown,
							_version: unknown,
							onLifecycleError: (errorJson: string) => void,
						) {
							lifecycleError = onLifecycleError;
							return runtime;
						},
					},
				}) as unknown as RuntimeWasm,
		});

		await service.request(
			{ type: "request", requestId: "start", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		lifecycleError('{"message":"another signed secret"}');

		const refused = await service
			.request(
				{ type: "request", requestId: "wipe", requestJson: '{"type":"wipe"}' },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);

		expect(refused).toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
			message: "Attachment Move preparation lifecycle failed.",
		});
		expect(runtime.requests.map((request) => request.requestJson)).toEqual([
			"{}",
		]);
	});

	/**
	 * A wedged Runtime whose `close()` stays in flight until the test releases it.
	 *
	 * Retiring it opens the window this suite protects: the cached Runtime is already gone, but the
	 * storage writes of its close are not finished.
	 */
	function gatedWedgedRetire() {
		const wedged = new RuntimeDouble();
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		let releaseClose!: () => void;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		wedged.close = async () => {
			wedged.closeCalls += 1;
			await closeGate;
		};
		const second = new RuntimeDouble();
		second.requestResult = Promise.resolve(wipeOutcome);
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			loadWasm: async () => {
				const runtime = loads++ === 0 ? wedged : second;
				return {
					WebClientRuntime: { withExecutors: () => runtime },
				} as unknown as RuntimeWasm;
			},
		});
		const retiring = service.request(
			{ type: "request", requestId: "plain", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		void retiring.catch(() => undefined);
		return {
			loads: () => loads,
			releaseClose,
			retiring,
			second,
			service,
			wedged,
		};
	}

	test("no second Runtime opens while a retiring one is still closing", async () => {
		const gated = gatedWedgedRetire();
		await flush();
		expect(gated.wedged.closeCalls).toBe(1);

		const duringClose = gated.service.request(
			{ type: "request", requestId: "wipe", requestJson: '{"type":"wipe"}' },
			new AbortController().signal,
			() => undefined,
		);
		await flush();

		expect(gated.second.requests).toEqual([]);
		expect(gated.second.openCalls).toBe(0);
		expect(gated.loads()).toBe(1);

		gated.releaseClose();
		await expect(gated.retiring).rejects.toThrow(
			"active Account has no durable Replica",
		);
		expect(await duringClose).toBe(wipeOutcome);
		expect(gated.loads()).toBe(2);
		expect(gated.second.openCalls).toBe(1);
	});

	test("close waits for a retiring Runtime to finish closing", async () => {
		const gated = gatedWedgedRetire();
		await flush();
		expect(gated.wedged.closeCalls).toBe(1);

		let closed = false;
		const closeTask = gated.service.close().then(() => {
			closed = true;
		});
		await flush();
		expect(closed).toBe(false);

		gated.releaseClose();
		await closeTask;
		expect(closed).toBe(true);
		await expect(gated.retiring).rejects.toThrow(
			"active Account has no durable Replica",
		);
	});

	test("close reports the terminal failure when a retiring close fails", async () => {
		const wedged = new RuntimeDouble();
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		let releaseClose!: () => void;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		wedged.close = async () => {
			wedged.closeCalls += 1;
			await closeGate;
			throw new Error("close leaked credential=close-secret");
		};
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () =>
				({
					WebClientRuntime: {
						withExecutors: () => wedged,
						withConfiguredAttachmentMovePreparation: () => wedged,
					},
				}) as unknown as RuntimeWasm,
		});

		const retiring = service.request(
			{ type: "request", requestId: "plain", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);
		void retiring.catch(() => undefined);
		await flush();
		expect(wedged.closeCalls).toBe(1);

		const closeTask = service.close();
		void closeTask.catch(() => undefined);
		releaseClose();

		await expect(closeTask).rejects.toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
		});
		// `close()` is memoized, so a later caller must see the same failed shutdown.
		await expect(service.close()).rejects.toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
		});
		await expect(retiring).rejects.toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
		});
	});

	test("a wipe reports success even when retiring its Runtime afterwards fails", async () => {
		const wedged = new RuntimeDouble();
		wedged.open = async () => {
			wedged.openCalls += 1;
			throw new Error("active Account has no durable Replica");
		};
		wedged.close = async () => {
			wedged.closeCalls += 1;
			throw new Error("close leaked credential=close-secret");
		};
		wedged.requestResult = Promise.resolve(wipeOutcome);
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			attachmentArtifactExecutor: {
				invoke: async () => ({ controlResponseJson: "{}" }),
			},
			binaryTransferExecutorFactory: () => ({
				...unavailableForegroundUploadBinary,
				invoke: async () => ({ controlResponseJson: "{}" }),
				close: () => undefined,
			}),
			accountLeaseExecutor: { acquire: async () => null },
			...authenticatedDownloadSinkPorts,
			authClient: { clientId: "client", platform: "web", version: "1" },
			loadWasm: async () =>
				({
					WebClientRuntime: {
						withExecutors: () => wedged,
						withConfiguredAttachmentMovePreparation: () => wedged,
					},
				}) as unknown as RuntimeWasm,
		});

		const wiped = await service.request(
			{ type: "request", requestId: "wipe", requestJson: '{"type":"wipe"}' },
			new AbortController().signal,
			() => undefined,
		);

		expect(wiped).toBe(wipeOutcome);
		expect(wedged.requests).toEqual([
			{ requestId: "wipe", requestJson: '{"type":"wipe"}' },
		]);
		expect(wedged.closeCalls).toBe(1);

		const later = await service
			.request(
				{ type: "request", requestId: "after-wipe", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			)
			.catch((error: unknown) => error);
		expect(later).toMatchObject({
			code: "ATTACHMENT_MOVE_PREPARATION_FAILED",
			message: "Attachment Move preparation lifecycle failed.",
		});
	});

	test("close preserves an explicit failure from an opened Runtime", async () => {
		const runtime = new RuntimeDouble();
		runtime.close = async () => {
			runtime.closeCalls += 1;
			throw new Error("Runtime close failed");
		};
		const { service } = runtimeService(runtime);
		await service.request(
			{ type: "request", requestId: "opened", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);

		const close = service.close();
		expect(service.close()).toBe(close);
		await expect(close).rejects.toThrow("Runtime close failed");
		expect(runtime.closeCalls).toBe(1);
	});

	test("forwards an observation before the observe acknowledgement", async () => {
		const runtime = new RuntimeDouble();
		const { service } = runtimeService(runtime);
		const order: string[] = [];

		await service
			.request(
				{ type: "observe", observationId: "vault", requestJson: "{}" },
				new AbortController().signal,
				(value) => order.push(`notification:${JSON.stringify(value)}`),
			)
			.then(() => order.push("ack"));

		expect(order).toEqual([
			'notification:{"type":"observation","observationId":"vault","projectionJson":"{\\"type\\":\\"initial\\"}"}',
			"ack",
		]);
	});

	test("outer cancellation cancels only the matching Runtime request", async () => {
		const runtime = new RuntimeDouble();
		let finish!: (value: string) => void;
		runtime.requestResult = new Promise((resolve) => {
			finish = resolve;
		});
		const { service } = runtimeService(runtime);
		const first = new AbortController();
		const second = new AbortController();
		const firstCall = service.request(
			{ type: "request", requestId: "first", requestJson: "{}" },
			first.signal,
			() => undefined,
		);
		const secondCall = service.request(
			{ type: "request", requestId: "second", requestJson: "{}" },
			second.signal,
			() => undefined,
		);

		for (let turn = 0; runtime.requests.length < 2 && turn < 8; turn += 1) {
			await Promise.resolve();
		}
		first.abort();
		await Promise.resolve();
		expect(runtime.cancelled).toEqual(["first"]);
		finish("{}");
		await Promise.all([firstCall, secondCall]);
	});

	test("outer cancellation removes an observation created before its ACK", async () => {
		const runtime = new RuntimeDouble();
		const { service } = runtimeService(runtime);
		const controller = new AbortController();

		await service.request(
			{ type: "observe", observationId: "vault", requestJson: "{}" },
			controller.signal,
			() => controller.abort(),
		);

		expect(runtime.observations.has("vault")).toBe(false);
	});

	test("cold authentication failure does not invoke IndexedDB", async () => {
		const runtime = new RuntimeDouble();
		const state = runtimeService(runtime);

		expect(
			await state.service.request(
				{
					type: "request",
					requestId: "cold",
					requestJson: '{"type":"CreateItem"}',
				},
				new AbortController().signal,
				() => undefined,
			),
		).toBe('{"type":"AuthenticationUnavailable"}');
		expect(state.persistenceInvocations()).toBe(0);
	});

	test("close awaits the Runtime once and rejects commands outside the closed set", async () => {
		const runtime = new RuntimeDouble();
		const { service } = runtimeService(runtime);
		await expect(
			service.request(
				{ type: "bootstrap" },
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toMatchObject({ code: "invalid-input" });
		await expect(
			service.request(
				{
					type: "request",
					requestId: "exact",
					requestJson: "{}",
					extra: true,
				},
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toMatchObject({ code: "invalid-input" });
		await service.request(
			{ type: "request", requestId: "ready", requestJson: "{}" },
			new AbortController().signal,
			() => undefined,
		);

		await Promise.all([service.close(), service.close()]);
		expect(runtime.closeCalls).toBe(1);
	});

	test("close stays cold when no command initialized the Runtime", async () => {
		let loads = 0;
		const service = createRuntimeWorkerService({
			executor: { invoke: async () => "{}" },
			platformStorageExecutor: { invoke: async () => "{}" },
			httpExecutor: { invoke: async () => "{}", cancel: () => undefined },
			loadWasm: async () => {
				loads += 1;
				throw new Error("must stay cold");
			},
		});

		await service.close();
		expect(loads).toBe(0);
		await expect(
			service.request(
				{ type: "request", requestId: "late", requestJson: "{}" },
				new AbortController().signal,
				() => undefined,
			),
		).rejects.toMatchObject({ code: "closed" });
		expect(loads).toBe(0);
	});
});

describe("Runtime main-thread facade", () => {
	test("installs before observe, and ignores unknown or late IDs", async () => {
		let subscriber: ((value: unknown) => void) | undefined;
		const requests: unknown[] = [];
		const channel = {
			async request<T = unknown>(payload: unknown): Promise<T> {
				requests.push(payload);
				if ((payload as { type?: string }).type === "observe") {
					subscriber?.({
						type: "observation",
						observationId: "vault",
						projectionJson: "initial",
					});
				}
				return undefined as T;
			},
			subscribe(listener: (value: unknown) => void) {
				subscriber = listener;
				return () => {
					subscriber = undefined;
				};
			},
		};
		const runtime = createWorkerRuntime(channel, async () => undefined);
		const first: string[] = [];

		await runtime.observe("vault", "{}", (value) => first.push(value));
		subscriber?.({
			type: "observation",
			observationId: "unknown",
			projectionJson: "ignored",
		});
		await runtime.unobserve("vault");
		subscriber?.({
			type: "observation",
			observationId: "vault",
			projectionJson: "late",
		});

		expect(first).toEqual(["initial"]);
		expect(requests.at(-1)).toEqual({
			type: "unobserve",
			observationId: "vault",
		});
	});

	test("rejects a duplicate observation id and leaves the first listener alone", async () => {
		let subscriber: ((value: unknown) => void) | undefined;
		const requests: unknown[] = [];
		const channel = {
			async request<T = unknown>(payload: unknown): Promise<T> {
				requests.push(payload);
				return undefined as T;
			},
			subscribe(listener: (value: unknown) => void) {
				subscriber = listener;
				return () => {
					subscriber = undefined;
				};
			},
		};
		const runtime = createWorkerRuntime(channel, async () => undefined);
		const first: string[] = [];
		const second: string[] = [];

		await runtime.observe("vault", "{}", (value) => first.push(value));
		await expect(
			runtime.observe("vault", "{}", (value) => second.push(value)),
		).rejects.toMatchObject({ code: "invalid-input" });

		subscriber?.({
			type: "observation",
			observationId: "vault",
			projectionJson: "kept",
		});

		expect(first).toEqual(["kept"]);
		expect(second).toEqual([]);
		// The rejected duplicate posts nothing, so it cannot close the live observation.
		expect(requests).toEqual([
			{ type: "observe", observationId: "vault", requestJson: "{}" },
		]);
	});

	test("cancel before observe ACK removes the listener and compensates with unobserve", async () => {
		let subscriber: ((value: unknown) => void) | undefined;
		const commands: unknown[] = [];
		const channel = {
			request<T = unknown>(
				payload: unknown,
				options?: { signal?: AbortSignal },
			): Promise<T> {
				commands.push(payload);
				if ((payload as { type?: string }).type === "unobserve") {
					return Promise.resolve(undefined as T);
				}
				return new Promise<T>((_resolve, reject) =>
					options?.signal?.addEventListener(
						"abort",
						() =>
							reject(
								Object.assign(new Error("cancelled"), { code: "cancelled" }),
							),
						{ once: true },
					),
				);
			},
			subscribe(listener: (value: unknown) => void) {
				subscriber = listener;
				return () => {
					subscriber = undefined;
				};
			},
		};
		const runtime = createWorkerRuntime(channel, async () => undefined);
		const controller = new AbortController();
		const projections: string[] = [];
		const observing = runtime.observe(
			"vault",
			"{}",
			(value) => projections.push(value),
			{ signal: controller.signal },
		);

		controller.abort();
		await expect(observing).rejects.toMatchObject({ code: "cancelled" });
		subscriber?.({
			type: "observation",
			observationId: "vault",
			projectionJson: "late",
		});

		expect(projections).toEqual([]);
		expect(commands.at(-1)).toEqual({
			type: "unobserve",
			observationId: "vault",
		});
	});
});
