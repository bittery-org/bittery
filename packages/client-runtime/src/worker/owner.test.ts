import { describe, expect, test } from "bun:test";
import { createWorkerHostRpc, type WorkerHostRpc } from "./host-rpc";
import { createSharedWorkerOwner, type SharedWorkerHandle } from "./owner";
import {
	serveWorkerChannels,
	type WorkerChannelService,
	type WorkerRouterScope,
} from "./router";

/** Stands in for a `KeyRef`: an opaque token whose prototype is not `Object.prototype`. */
class OpaqueTokenDouble {}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class MultiplexWorkerDouble implements SharedWorkerHandle {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminateCalls = 0;
	nextPostFailure: Error | null = null;
	readonly requests: Array<{ channel: string; id: number }> = [];
	readonly host: WorkerHostRpc;
	private readonly listeners = new Set<(event: { data: unknown }) => void>();

	constructor(
		services:
			| Readonly<Record<string, WorkerChannelService>>
			| ((
					host: WorkerHostRpc,
			  ) => Readonly<Record<string, WorkerChannelService>>),
	) {
		const scope: WorkerRouterScope = {
			addEventListener: (_type, listener) => {
				this.listeners.add(listener);
			},
			postMessage: (message) => {
				const copy = structuredClone(message);
				queueMicrotask(() =>
					this.onmessage?.(new MessageEvent("message", { data: copy })),
				);
			},
		};
		this.host = createWorkerHostRpc(scope);
		serveWorkerChannels(
			scope,
			typeof services === "function" ? services(this.host) : services,
		);
	}

	postMessage(message: unknown): void {
		if (this.nextPostFailure !== null) {
			const failure = this.nextPostFailure;
			this.nextPostFailure = null;
			throw failure;
		}
		const copy = structuredClone(message);
		if (
			typeof copy === "object" &&
			copy !== null &&
			(copy as { type?: unknown }).type === "request"
		) {
			const request = copy as { channel: string; id: number };
			this.requests.push({ channel: request.channel, id: request.id });
		}
		queueMicrotask(() => {
			for (const listener of this.listeners) listener({ data: copy });
		});
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	fail(message: string): void {
		this.onerror?.(new ErrorEvent("error", { message }));
	}

	emitToMain(message: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: message }));
	}

	emitToWorker(message: unknown): void {
		for (const listener of this.listeners) listener({ data: message });
	}
}

describe("shared worker RPC", () => {
	test("channel subscriptions receive clone-safe notifications until detached", async () => {
		const worker = new MultiplexWorkerDouble({
			runtime: {
				request: async (_payload, _signal, notify) => {
					notify({ observationId: "known", bytes: new Uint8Array([1, 2]) });
					return "observing";
				},
			},
		});
		const channel = createSharedWorkerOwner({
			createWorker: () => worker,
		}).channel("runtime");
		const notifications: unknown[] = [];
		const detach = channel.subscribe((value) => notifications.push(value));

		expect(await channel.request<string>({})).toBe("observing");
		await Promise.resolve();
		expect(notifications).toEqual([
			{ observationId: "known", bytes: new Uint8Array([1, 2]) },
		]);

		detach();
		worker.emitToMain({
			type: "notification",
			channel: "runtime",
			value: { observationId: "late" },
		});
		expect(notifications).toHaveLength(1);
	});

	test("one worker correlates reverse-order replies independently per channel", async () => {
		const cryptoAnswer = deferred<unknown>();
		const runtimeAnswer = deferred<unknown>();
		let workersCreated = 0;
		const worker = new MultiplexWorkerDouble({
			crypto: { request: () => cryptoAnswer.promise },
			runtime: { request: () => runtimeAnswer.promise },
		});
		const owner = createSharedWorkerOwner({
			createWorker: () => {
				workersCreated += 1;
				return worker;
			},
		});

		const crypto = owner.channel("crypto").request({ operation: "derive" });
		const runtime = owner.channel("runtime").request({ operation: "observe" });
		runtimeAnswer.resolve({ channel: "runtime" });
		cryptoAnswer.resolve({ channel: "crypto" });

		expect(await runtime).toEqual({ channel: "runtime" });
		expect(await crypto).toEqual({ channel: "crypto" });
		expect(workersCreated).toBe(1);
		expect(worker.requests).toEqual([
			{ channel: "crypto", id: 0 },
			{ channel: "runtime", id: 0 },
		]);
	});

	test("caller cancellation is routed only to its channel request", async () => {
		const workerCancelled = deferred<void>();
		const worker = new MultiplexWorkerDouble({
			crypto: {
				request: async (_payload, signal) => {
					await new Promise<void>((resolve) =>
						signal.addEventListener(
							"abort",
							() => {
								workerCancelled.resolve();
								resolve();
							},
							{ once: true },
						),
					);
				},
			},
			runtime: { request: async () => "still-live" },
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });
		const controller = new AbortController();
		const request = owner
			.channel("crypto")
			.request({ operation: "slow" }, { signal: controller.signal });
		await Promise.resolve();

		controller.abort();

		await expect(request).rejects.toMatchObject({ code: "cancelled" });
		await workerCancelled.promise;
		expect(await owner.channel("runtime").request<string>({})).toBe(
			"still-live",
		);
	});

	test("a worker crash rejects pending calls on every channel", async () => {
		const cryptoWork = deferred<unknown>();
		const runtimeWork = deferred<unknown>();
		const worker = new MultiplexWorkerDouble({
			crypto: { request: async () => cryptoWork.promise },
			runtime: { request: async () => runtimeWork.promise },
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });
		const crypto = owner.channel("crypto").request({});
		const runtime = owner.channel("runtime").request({});
		const failures = [crypto, runtime].map((request) =>
			request.catch((error: unknown) => error),
		);

		worker.fail("shared worker crashed");

		expect(await Promise.all(failures)).toEqual([
			expect.objectContaining({
				code: "backend-failure",
				message: "shared worker crashed",
			}),
			expect.objectContaining({
				code: "backend-failure",
				message: "shared worker crashed",
			}),
		]);
		await expect(owner.channel("crypto").request({})).rejects.toMatchObject({
			code: "backend-failure",
		});
		await expect(owner.close()).rejects.toMatchObject({
			code: "backend-failure",
			message: "shared worker crashed",
		});
		expect(worker.terminateCalls).toBe(1);
		expect(worker.onmessage).toBeNull();
		expect(worker.onerror).toBeNull();
		cryptoWork.resolve(undefined);
		runtimeWork.resolve(undefined);
	});

	test("forbidden structured-clone shapes are rejected before a worker starts", async () => {
		let workersCreated = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => {
				workersCreated += 1;
				return new MultiplexWorkerDouble({
					crypto: { request: async (payload) => payload },
				});
			},
		});

		const keyRef = new OpaqueTokenDouble();
		const forbidden = [
			() => undefined,
			new Error("secret detail"),
			new AbortController().signal,
			new Request("https://bittery.test"),
			new Response("secret body"),
			keyRef,
		];
		for (const value of forbidden) {
			await expect(
				owner.channel("crypto").request({ nested: value }),
			).rejects.toMatchObject({ code: "invalid-input" });
		}
		expect(workersCreated).toBe(0);
	});

	test("close waits for the worker ACK before terminating and is idempotent", async () => {
		const mayClose = deferred<void>();
		let serviceCloseCalls = 0;
		const worker = new MultiplexWorkerDouble({
			crypto: {
				request: async () => "ready",
				close: async () => {
					serviceCloseCalls += 1;
					await mayClose.promise;
				},
			},
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });
		expect(await owner.channel("crypto").request<string>({})).toBe("ready");

		const first = owner.close();
		const second = owner.close();
		await Promise.resolve();
		worker.emitToMain({ type: "close-ack", id: 0, ok: false });
		expect(worker.terminateCalls).toBe(0);
		mayClose.resolve();
		await Promise.all([first, second]);

		expect(serviceCloseCalls).toBe(1);
		expect(worker.terminateCalls).toBe(1);
		await owner.close();
		expect(worker.terminateCalls).toBe(1);
	});

	test("unknown messages on either side are ignored", async () => {
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "healthy" },
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });
		expect(await owner.channel("runtime").request<string>({})).toBe("healthy");

		worker.emitToMain(null);
		worker.emitToMain({
			type: "response",
			channel: "missing",
			id: 42,
			ok: true,
			value: "late",
		});
		worker.emitToWorker(new Error("not wire data"));

		expect(await owner.channel("runtime").request<string>({})).toBe("healthy");
	});

	test("a valid request for an unattached channel is rejected instead of hanging", async () => {
		const worker = new MultiplexWorkerDouble({
			crypto: { request: async () => "ready" },
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });

		await expect(owner.channel("runtime").request({})).rejects.toMatchObject({
			code: "closed",
		});
	});

	test("an unknown channel is rejected as invalid wire data", async () => {
		let listener!: (event: { data: unknown }) => void;
		const replies: unknown[] = [];
		let serviceCalls = 0;
		serveWorkerChannels(
			{
				addEventListener: (_type, nextListener) => {
					listener = nextListener;
				},
				postMessage: (message) => replies.push(message),
			},
			{
				crypto: {
					request: async () => {
						serviceCalls += 1;
					},
				},
			},
		);

		listener({
			data: {
				type: "request",
				channel: "diagnostics",
				id: 0,
				payload: {},
			},
		});
		await Promise.resolve();

		expect(serviceCalls).toBe(0);
		expect(replies).toEqual([]);
	});

	test("a synchronous postMessage failure rejects only that pending call", async () => {
		const worker = new MultiplexWorkerDouble({
			crypto: { request: async () => "healthy" },
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });
		expect(await owner.channel("crypto").request<string>({})).toBe("healthy");
		worker.nextPostFailure = new Error("postMessage failed");

		await expect(owner.channel("crypto").request({})).rejects.toMatchObject({
			code: "backend-failure",
			message: "postMessage failed",
		});
		expect(await owner.channel("crypto").request<string>({})).toBe("healthy");
	});

	test("byte buffers are copied in both directions without detaching", async () => {
		const received = deferred<Uint8Array>();
		const reply = deferred<unknown>();
		const worker = new MultiplexWorkerDouble({
			runtime: {
				request: async (payload) => {
					received.resolve((payload as { bytes: Uint8Array }).bytes);
					return reply.promise;
				},
			},
		});
		const owner = createSharedWorkerOwner({ createWorker: () => worker });
		const source = new Uint8Array([1, 2, 3]);
		const response = owner.channel("runtime").request<{ bytes: Uint8Array }>({
			bytes: source,
		});
		source[0] = 9;
		const workerBytes = await received.promise;
		expect([...workerBytes]).toEqual([1, 2, 3]);
		expect(source.byteLength).toBe(3);

		const workerReply = new Uint8Array([4, 5, 6]);
		reply.resolve({ bytes: workerReply });
		const result = await response;
		workerReply[0] = 8;

		expect([...result.bytes]).toEqual([4, 5, 6]);
		expect(workerReply.byteLength).toBe(3);
	});

	test("worker host requests use an independent id space and correlate reverse-order replies", async () => {
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					const answers = await Promise.all([
						host.request({ hostCall: "first" }),
						host.request({ hostCall: "second" }),
					]);
					return answers;
				},
			},
		}));
		const seen: unknown[] = [];
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (payload) => {
				seen.push(payload);
				return (payload as { hostCall: string }).hostCall === "first"
					? first.promise
					: second.promise;
			},
		});

		const result = owner
			.channel("runtime")
			.request<unknown[]>({ productCall: true });
		await Promise.resolve();
		await Promise.resolve();
		second.resolve("second-answer");
		first.resolve("first-answer");

		expect(await result).toEqual(["first-answer", "second-answer"]);
		expect(seen).toEqual([{ hostCall: "first" }, { hostCall: "second" }]);
		expect(worker.requests).toEqual([{ channel: "runtime", id: 0 }]);
	});

	test("a missing host handler fails closed without affecting later product requests", async () => {
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async (payload) =>
					(payload as { useHost?: boolean }).useHost
						? host.request("needed")
						: "healthy",
			},
		}));
		const owner = createSharedWorkerOwner({ createWorker: () => worker });

		await expect(
			owner.channel("runtime").request({ useHost: true }),
		).rejects.toMatchObject({ code: "closed" });
		expect(await owner.channel("runtime").request<string>({})).toBe("healthy");
	});

	test("host requests and responses enforce the same clone-safe vocabulary", async () => {
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async (payload) =>
					host.request((payload as { value: unknown }).value),
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (payload) =>
				payload === "bad-response" ? () => undefined : payload,
		});

		await expect(
			owner.channel("runtime").request({ value: () => undefined }),
		).rejects.toMatchObject({ code: "invalid-input" });
		await expect(
			owner.channel("runtime").request({ value: "bad-response" }),
		).rejects.toMatchObject({ code: "invalid-input" });
		expect(
			await owner
				.channel("runtime")
				.request<Uint8Array>({ value: new Uint8Array([3, 4]) }),
		).toEqual(new Uint8Array([3, 4]));
	});

	test("unknown and late host responses are ignored", async () => {
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => host.request("known"),
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => "answer",
		});

		worker.emitToWorker({
			type: "host-response",
			id: 99,
			ok: true,
			value: "late",
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("answer");
		worker.emitToWorker({
			type: "host-response",
			id: 0,
			ok: true,
			value: "later",
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("answer");
	});

	test("close aborts main-thread host work and rejects the worker-side wait", async () => {
		const hostStarted = deferred<void>();
		const hostAborted = deferred<void>();
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: { request: async () => host.request("slow") },
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (_payload, signal) => {
				hostStarted.resolve();
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						"abort",
						() => {
							hostAborted.resolve();
							resolve();
						},
						{ once: true },
					),
				);
				return "too-late";
			},
		});
		const request = owner.channel("runtime").request({});
		await hostStarted.promise;

		const close = owner.close();

		await expect(request).rejects.toMatchObject({ code: "closed" });
		await hostAborted.promise;
		await close;
	});

	test("a worker crash aborts pending main-thread host work", async () => {
		const hostStarted = deferred<void>();
		const hostAborted = deferred<void>();
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: { request: async () => host.request("slow") },
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (_payload, signal) => {
				hostStarted.resolve();
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						"abort",
						() => {
							hostAborted.resolve();
							resolve();
						},
						{ once: true },
					),
				);
				return "too-late";
			},
		});
		const request = owner.channel("runtime").request({});
		await hostStarted.promise;

		worker.fail("crashed during host work");

		await expect(request).rejects.toMatchObject({
			code: "backend-failure",
			message: "crashed during host work",
		});
		await hostAborted.promise;
	});
});
