import { describe, expect, test } from "bun:test";
import { createKeyRefTable } from "./key-ref";
import {
	createSharedWorkerOwner,
	type SharedWorkerHandle,
} from "./shared-worker-rpc";
import {
	serveWorkerChannels,
	type WorkerChannelService,
	type WorkerRouterScope,
} from "./worker-router";

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
	private listener: ((event: { data: unknown }) => void) | null = null;

	constructor(services: Readonly<Record<string, WorkerChannelService>>) {
		const scope: WorkerRouterScope = {
			addEventListener: (_type, listener) => {
				this.listener = listener;
			},
			postMessage: (message) => {
				const copy = structuredClone(message);
				queueMicrotask(() =>
					this.onmessage?.(new MessageEvent("message", { data: copy })),
				);
			},
		};
		serveWorkerChannels(scope, services);
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
		queueMicrotask(() => this.listener?.({ data: copy }));
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
		this.listener?.({ data: message });
	}
}

describe("shared worker RPC", () => {
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

		const keyRef = createKeyRefTable<number>().create(1);
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
});
