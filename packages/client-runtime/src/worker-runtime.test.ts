import { describe, expect, test } from "bun:test";
import {
	createRuntimeWorkerService,
	createWorkerRuntime,
	type RuntimeWasm,
} from "./worker-runtime";

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
	test("passes both serialized executors and opens once before serving commands", async () => {
		const runtime = new RuntimeDouble();
		const calls: string[] = [];
		let replicaInvoke: ((requestJson: string) => Promise<string>) | undefined;
		let platformInvoke: ((requestJson: string) => Promise<string>) | undefined;
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
			loadWasm: async () => ({
				WebClientRuntime: {
					withExecutors(replica, platform) {
						replicaInvoke = replica;
						platformInvoke = platform;
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
		expect(await replicaInvoke?.('{"type":"read"}')).toBe("replica-result");
		expect(await platformInvoke?.('{"type":"get"}')).toBe("platform-result");
		expect(calls).toEqual([
			'replica:{"type":"read"}',
			'platform:{"type":"get"}',
		]);
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
	test("installs before observe, replaces listeners, and ignores unknown or late IDs", async () => {
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
		const replacement: string[] = [];

		await runtime.observe("vault", "{}", (value) => first.push(value));
		await runtime.observe("vault", "{}", (value) => replacement.push(value));
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
		expect(replacement).toEqual(["initial"]);
		expect(requests.at(-1)).toEqual({
			type: "unobserve",
			observationId: "vault",
		});
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
