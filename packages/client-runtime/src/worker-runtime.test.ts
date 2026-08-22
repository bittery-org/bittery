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
	requestResult = Promise.resolve('{"type":"AuthenticationUnavailable"}');

	cancel(requestId: string): void {
		this.cancelled.push(requestId);
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
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
	const service = createRuntimeWorkerService({
		executor: {
			async invoke() {
				persistenceInvocations += 1;
				return "{}";
			},
		},
		loadWasm: async () =>
			({
				WebClientRuntime: {
					withReplicaExecutor: () => runtime,
				},
			}) as unknown as RuntimeWasm,
	});
	return { service, persistenceInvocations: () => persistenceInvocations };
}

describe("Runtime worker service", () => {
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

		await Promise.resolve();
		await Promise.resolve();
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
			loadWasm: async () => {
				loads += 1;
				throw new Error("must stay cold");
			},
		});

		await service.close();
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
