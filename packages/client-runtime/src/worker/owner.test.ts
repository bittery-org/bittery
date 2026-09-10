import { describe, expect, test } from "bun:test";
import {
	isAttachmentDownloadSinkHostRequest,
	isAttachmentDownloadSinkRuntimeScopeRequest,
} from "../web-attachment-download-sink";
import { createWorkerHostRpc, type WorkerHostRpc } from "./host-rpc";
import { createSharedWorkerOwner, type SharedWorkerHandle } from "./owner";
import {
	serveWorkerChannels,
	type WorkerChannelService,
	type WorkerRouterScope,
} from "./router";
import { prepareWorkerValueForPost } from "./wire";

/** Stands in for a `KeyRef`: an opaque token whose prototype is not `Object.prototype`. */
class OpaqueTokenDouble {}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function hostilePlaintext(values: number[]) {
	const bytes = new Uint8Array(values);
	let getterCalls = 0;
	for (const key of [
		"buffer",
		"byteOffset",
		"byteLength",
		"length",
		Symbol.iterator,
		"custom",
	] as const) {
		Object.defineProperty(bytes, key, {
			configurable: true,
			get: () => {
				getterCalls += 1;
				throw new Error("hostile binary accessor");
			},
		});
	}
	return { bytes, getterCalls: () => getterCalls };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class MultiplexWorkerDouble implements SharedWorkerHandle {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onmessageerror: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminateCalls = 0;
	onTerminate: (() => void) | null = null;
	onPostToMain: ((message: unknown) => void) | null = null;
	onPostToWorker: ((message: unknown) => void) | null = null;
	nextPostFailure: Error | null = null;
	nextWorkerPostFailure: Error | null = null;
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
			postMessage: (message, transfer) => {
				if (this.nextWorkerPostFailure !== null) {
					const failure = this.nextWorkerPostFailure;
					this.nextWorkerPostFailure = null;
					throw failure;
				}
				const copy = structuredClone(message, { transfer });
				this.onPostToMain?.(copy);
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

	postMessage(message: unknown, transfer?: Transferable[]): void {
		if (this.nextPostFailure !== null) {
			const failure = this.nextPostFailure;
			this.nextPostFailure = null;
			throw failure;
		}
		const copy = structuredClone(message, { transfer });
		this.onPostToWorker?.(copy);
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
		this.onTerminate?.();
	}

	fail(message: string): void {
		this.onerror?.(new ErrorEvent("error", { message }));
	}

	failMessage(): void {
		this.onmessageerror?.(new MessageEvent("messageerror"));
	}

	emitToMain(message: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: message }));
	}

	emitToWorker(message: unknown): void {
		for (const listener of this.listeners) listener({ data: message });
	}
}

describe("shared worker RPC", () => {
	test("transfers the exact Attachment Download plaintext chunk out of the Worker", async () => {
		let workerReference: Uint8Array | undefined;
		let hostReference: Uint8Array | undefined;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					workerReference = new Uint8Array([1, 2, 3]);
					return host.request<string>({
						type: "attachmentDownloadSink",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"write","capabilityId":"x"}',
						binaryChunk: workerReference,
					});
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (payload) => {
				hostReference = (payload as { binaryChunk: Uint8Array }).binaryChunk;
				return "written";
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("written");
		expect(workerReference?.byteLength).toBe(0);
		expect(hostReference).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("transfers one owned Attachment Upload plaintext chunk into the Worker", async () => {
		let mainReference: Uint8Array | undefined;
		let workerReference: Uint8Array | undefined;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					const result = await host.request<{
						controlResponseJson: string;
						binaryChunk: Uint8Array;
					}>({
						type: "attachmentUploadSource",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"read"}',
					});
					workerReference = result.binaryChunk;
					return result.controlResponseJson;
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				mainReference = new Uint8Array([4, 5, 6]);
				return {
					controlResponseJson: '{"type":"chunk"}',
					binaryChunk: mainReference,
				};
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe(
			'{"type":"chunk"}',
		);
		expect(mainReference?.byteLength).toBe(0);
		expect(workerReference).toEqual(new Uint8Array([4, 5, 6]));
	});

	test("wipes every retained Attachment Upload alias when main-to-Worker postMessage throws synchronously", async () => {
		let source: Uint8Array | undefined;
		let alias: Uint8Array | undefined;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () =>
					host.request({
						type: "attachmentUploadSource",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"read"}',
					}),
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				source = new Uint8Array([4, 5, 6]);
				alias = new Uint8Array(source.buffer);
				worker.nextPostFailure = new Error("upload response post failed");
				return {
					controlResponseJson: '{"type":"chunk"}',
					binaryChunk: source,
				};
			},
		});
		await expect(owner.channel("runtime").request({})).rejects.toMatchObject({
			code: "backend-failure",
		});
		expect(source?.byteLength).toBe(3);
		expect(source).toEqual(new Uint8Array(3));
		expect(alias).toEqual(new Uint8Array(3));
	});

	test("wipes every retained Attachment Download alias when Worker-to-main postMessage throws synchronously", async () => {
		let source: Uint8Array | undefined;
		let alias: Uint8Array | undefined;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					source = new Uint8Array([7, 8, 9]);
					alias = new Uint8Array(source.buffer);
					worker.nextWorkerPostFailure = new Error(
						"download request post failed",
					);
					return host.request({
						type: "attachmentDownloadSink",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"write"}',
						binaryChunk: source,
					});
				},
			},
		}));
		const owner = createSharedWorkerOwner({ createWorker: () => worker });

		await expect(owner.channel("runtime").request({})).rejects.toMatchObject({
			code: "backend-failure",
		});
		expect(source?.byteLength).toBe(3);
		expect(source).toEqual(new Uint8Array(3));
		expect(alias).toEqual(new Uint8Array(3));
	});

	test("rejects every invalid Attachment Upload answer/binary pairing and wipes the main-thread alias", async () => {
		for (const response of [
			{ controlResponseJson: "{" },
			{ controlResponseJson: '{"type":"chunk"}' },
			{ controlResponseJson: '{"type":"end"}', withBinary: true },
			{ controlResponseJson: '{"type":"claimed"}', withBinary: true },
			{ controlResponseJson: '{"type":"closed"}', withBinary: true },
			{ controlResponseJson: '{"type":"retired"}', withBinary: true },
			{
				controlResponseJson: '{"type":"retirementCompleted"}',
				withBinary: true,
			},
			{ controlResponseJson: '{"type":"sourceFailure"}', withBinary: true },
			{ controlResponseJson: '{"type":"cancelled"}', withBinary: true },
			{
				controlResponseJson: '{"type":"invariantViolation"}',
				withBinary: true,
			},
		]) {
			let mainReference: Uint8Array | undefined;
			const worker = new MultiplexWorkerDouble((host) => ({
				runtime: {
					request: async () =>
						host.request({
							type: "attachmentUploadSource",
							runtimeIncarnation: "runtime-one",
							controlRequestJson: '{"type":"read"}',
						}),
				},
			}));
			const owner = createSharedWorkerOwner({
				createWorker: () => worker,
				handleHostRequest: async () => {
					if (response.withBinary) mainReference = new Uint8Array([7, 8, 9]);
					return {
						controlResponseJson: response.controlResponseJson,
						...(mainReference === undefined
							? {}
							: { binaryChunk: mainReference }),
					};
				},
			});
			await expect(owner.channel("runtime").request({})).rejects.toMatchObject({
				code: "invalid-input",
			});
			if (mainReference !== undefined)
				expect([...mainReference]).toEqual([0, 0, 0]);
		}
	});

	test("wipes partial and extra-field Attachment Upload plaintext before generic cloning", async () => {
		for (const kind of ["partial", "extra", "dataView"] as const) {
			let backing: Uint8Array | undefined;
			const worker = new MultiplexWorkerDouble((host) => ({
				runtime: {
					request: async () =>
						host.request({
							type: "attachmentUploadSource",
							runtimeIncarnation: "runtime-one",
							controlRequestJson: '{"type":"read"}',
						}),
				},
			}));
			const owner = createSharedWorkerOwner({
				createWorker: () => worker,
				handleHostRequest: async () => {
					backing = new Uint8Array([9, 1, 2, 8]);
					return {
						controlResponseJson: '{"type":"chunk"}',
						binaryChunk:
							kind === "partial"
								? new Uint8Array(backing.buffer, 1, 2)
								: kind === "dataView"
									? new DataView(backing.buffer, 1, 2)
									: backing,
						...(kind === "extra" ? { extra: true } : {}),
					};
				},
			});
			await expect(owner.channel("runtime").request({})).rejects.toMatchObject({
				code: "invalid-input",
			});
			expect([...(backing ?? [])]).toEqual([0, 0, 0, 0]);
		}
	});

	test("wipes a malformed known Worker-side Attachment Upload binary alias without settling", async () => {
		const hostStarted = deferred<void>();
		const releaseHost = deferred<void>();
		let workerAlias: Uint8Array | undefined;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					const pending = host.request({
						type: "attachmentUploadSource",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"read"}',
					});
					await hostStarted.promise;
					workerAlias = new Uint8Array([4, 3, 2, 1]);
					worker.emitToWorker({
						type: "host-response",
						id: 0,
						ok: true,
						value: {
							controlResponseJson: '{"type":"chunk"}',
							binaryChunk: new Uint8Array(workerAlias.buffer, 1, 2),
						},
					});
					return pending;
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostStarted.resolve();
				await releaseHost.promise;
				return { controlResponseJson: '{"type":"end"}' };
			},
		});
		const request = owner.channel("runtime").request({});
		await hostStarted.promise;
		await flush();
		expect([...(workerAlias ?? [])]).toEqual([0, 0, 0, 0]);
		releaseHost.resolve();
		expect(await request).toEqual({ controlResponseJson: '{"type":"end"}' });
	});

	test("rejects a transferred partial plaintext view before invoking the host", async () => {
		let workerBacking: Uint8Array | undefined;
		let hostCalls = 0;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					workerBacking = new Uint8Array([9, 1, 2, 8]);
					const partial = new Uint8Array(workerBacking.buffer, 1, 2);
					return host.request<string>({
						type: "attachmentDownloadSink",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"write","capabilityId":"x"}',
						binaryChunk: partial,
					});
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostCalls += 1;
				return "must-not-run";
			},
		});
		await expect(
			owner.channel("runtime").request<string>({}),
		).rejects.toMatchObject({ code: "invalid-input" });
		expect(workerBacking).toEqual(new Uint8Array(4));
		expect(hostCalls).toBe(0);
	});

	test("rejects SharedArrayBuffer plaintext and wipes every retained alias", () => {
		const backing = new Uint8Array(new SharedArrayBuffer(4));
		backing.set([9, 1, 2, 8]);
		const partial = new Uint8Array(backing.buffer, 1, 2);
		expect(() =>
			prepareWorkerValueForPost({
				type: "attachmentDownloadSink",
				runtimeIncarnation: "runtime-one",
				controlRequestJson: '{"type":"write","capabilityId":"x"}',
				binaryChunk: partial,
			}),
		).toThrow("owned ArrayBuffer");
		expect(Array.from(backing)).toEqual([0, 0, 0, 0]);
	});

	test("malformed reverse RPC is settled once without escaping the message boundary", async () => {
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready" },
		});
		const responses: unknown[] = [];
		worker.onPostToWorker = (message) => {
			if ((message as { type?: unknown }).type === "host-response") {
				responses.push(message);
			}
		};
		let hostCalls = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostCalls += 1;
				return "must-not-run";
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("ready");

		expect(() =>
			worker.emitToMain({ type: "host-request", id: 41, payload: new Map() }),
		).not.toThrow();
		await flush();

		expect(hostCalls).toBe(0);
		expect(responses).toEqual([
			{
				type: "host-response",
				id: 41,
				ok: false,
				code: "invalid-input",
				message: "The worker boundary accepts only plain data and byte arrays.",
			},
		]);
		await owner.close();
	});

	test("a throwing reverse-RPC preservation classifier fails closed without invoking the host", async () => {
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready" },
		});
		const responses: unknown[] = [];
		worker.onPostToWorker = (message) => {
			if ((message as { type?: unknown }).type === "host-response") {
				responses.push(message);
			}
		};
		let hostCalls = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostCalls += 1;
				return "must-not-run";
			},
			preserveHostRequestDuringClose: () => {
				throw new Error("classifier escaped");
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("ready");

		expect(() =>
			worker.emitToMain({ type: "host-request", id: 42, payload: {} }),
		).not.toThrow();
		await flush();

		expect(hostCalls).toBe(0);
		expect(responses).toEqual([
			expect.objectContaining({
				type: "host-response",
				id: 42,
				ok: false,
				code: "backend-failure",
			}),
		]);
		await owner.close();
	});

	test("malformed reverse RPC during close settles and cannot delay exact termination", async () => {
		const releaseClose = deferred<void>();
		const worker = new MultiplexWorkerDouble({
			runtime: {
				request: async () => "ready",
				close: async () => releaseClose.promise,
			},
		});
		const responses: unknown[] = [];
		let closeAcks = 0;
		worker.onPostToWorker = (message) => {
			if ((message as { type?: unknown }).type === "host-response") {
				responses.push(message);
			}
		};
		worker.onPostToMain = (message) => {
			if ((message as { type?: unknown }).type === "close-ack") closeAcks += 1;
		};
		let closingHostCalls = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleClosingHostRequest: async () => {
				closingHostCalls += 1;
				return "must-not-run";
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("ready");
		const close = owner.close();

		expect(() =>
			worker.emitToMain({ type: "host-request", id: 43, payload: new Map() }),
		).not.toThrow();
		await flush();
		expect(responses).toEqual([
			expect.objectContaining({ id: 43, ok: false, code: "invalid-input" }),
		]);
		expect(closingHostCalls).toBe(0);
		expect(worker.terminateCalls).toBe(0);

		releaseClose.resolve();
		await close;
		expect(closeAcks).toBe(1);
		expect(worker.terminateCalls).toBe(1);
		expect(owner.close()).toBe(close);
	});

	test("duplicate reverse-RPC ids receive one failure and never overwrite active host work", async () => {
		const hostStarted = deferred<void>();
		const releaseHost = deferred<void>();
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready" },
		});
		const responses: unknown[] = [];
		worker.onPostToWorker = (message) => {
			if ((message as { type?: unknown }).type === "host-response") {
				responses.push(message);
			}
		};
		let hostCalls = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (_payload, signal) => {
				hostCalls += 1;
				hostStarted.resolve();
				await releaseHost.promise;
				return signal.aborted ? "aborted" : "must-not-settle";
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("ready");
		worker.emitToMain({ type: "host-request", id: 44, payload: { call: 1 } });
		await hostStarted.promise;

		expect(() =>
			worker.emitToMain({ type: "host-request", id: 44, payload: { call: 2 } }),
		).not.toThrow();
		await Promise.resolve();
		expect(hostCalls).toBe(1);
		expect(responses).toEqual([
			expect.objectContaining({ id: 44, ok: false, code: "invalid-input" }),
		]);

		releaseHost.resolve();
		await owner.close();
		expect(responses).toHaveLength(1);
		expect(worker.terminateCalls).toBe(1);
	});
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

	test("close keeps cleanup reverse RPC alive and drains host state before Worker termination", async () => {
		const events: string[] = [];
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => "ready",
				close: async () => {
					events.push("runtime-close");
					await host.request({ type: "cleanup" });
					events.push("discard-drained");
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => "normal",
			handleClosingHostRequest: async (payload) => {
				expect(payload).toEqual({ type: "cleanup" });
				events.push("discard");
				return "discarded";
			},
			preserveHostRequestDuringClose: () => true,
			beforeWorkerTerminate: async () => {
				events.push("registry-drained");
			},
		});
		await owner.channel("runtime").request({});
		await owner.close();
		expect(events).toEqual([
			"runtime-close",
			"discard",
			"discard-drained",
			"registry-drained",
		]);
		expect(worker.terminateCalls).toBe(1);
	});

	for (const failureKind of ["messageerror", "error"] as const) {
		test(`a ${failureKind} after close ACK overrides provisional success while preserved host cleanup drains`, async () => {
			const hostStarted = deferred<void>();
			const releaseHost = deferred<void>();
			const workerCloseStarted = deferred<void>();
			const closeAckPosted = deferred<void>();
			const events: string[] = [];
			const worker = new MultiplexWorkerDouble((host) => ({
				runtime: {
					request: async () => host.request({ type: "preserved-cleanup" }),
					close: async () => workerCloseStarted.resolve(),
				},
			}));
			worker.onTerminate = () => events.push("terminated");
			worker.onPostToMain = (message) => {
				if ((message as { type?: unknown }).type === "close-ack") {
					closeAckPosted.resolve();
				}
			};
			const owner = createSharedWorkerOwner({
				createWorker: () => worker,
				handleHostRequest: async () => {
					hostStarted.resolve();
					await releaseHost.promise;
					events.push("host-drained");
					return "done";
				},
				preserveHostRequestDuringClose: () => true,
				beforeWorkerTerminate: async () => {
					events.push("before-terminate");
				},
			});
			const request = owner.channel("runtime").request({});
			void request.catch(() => undefined);
			await hostStarted.promise;

			const close = owner.close();
			void close.catch(() => undefined);
			expect(owner.close()).toBe(close);
			await workerCloseStarted.promise;
			await closeAckPosted.promise;
			await Promise.resolve();
			expect(worker.terminateCalls).toBe(0);

			if (failureKind === "messageerror") worker.failMessage();
			else worker.fail("worker failed after close ACK");
			worker.emitToMain({ type: "close-ack", id: 0, ok: true });
			worker.fail("duplicate worker failure");
			expect(owner.close()).toBe(close);
			expect(worker.terminateCalls).toBe(0);

			releaseHost.resolve();
			await expect(close).rejects.toMatchObject({ code: "backend-failure" });
			expect(events).toEqual([
				"host-drained",
				"before-terminate",
				"terminated",
			]);
			expect(worker.terminateCalls).toBe(1);
			await expect(owner.close()).rejects.toMatchObject({
				code: "backend-failure",
			});
			expect(worker.terminateCalls).toBe(1);
		});
	}

	test("a cleanup failure retains the Worker until an identical close retry drains", async () => {
		let cleanups = 0;
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready", close: async () => undefined },
		});
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			beforeWorkerTerminate: async () => {
				cleanups += 1;
				if (cleanups === 1) throw new Error("registry cleanup failed");
			},
		});
		await owner.channel("runtime").request({});
		await expect(owner.close()).rejects.toThrow("registry cleanup failed");
		expect(worker.terminateCalls).toBe(0);
		await expect(owner.channel("runtime").request({})).rejects.toMatchObject({
			code: "closed",
		});
		await expect(owner.close()).resolves.toBeUndefined();
		expect(cleanups).toBe(2);
		expect(worker.terminateCalls).toBe(1);
	});

	test("a Worker crash automatically fences and drains main-thread ownership", async () => {
		const drained = deferred<void>();
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready" },
		});
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			beforeWorkerTerminate: async () => drained.resolve(),
		});
		await owner.channel("runtime").request({});
		worker.fail("worker crashed");
		await drained.promise;
		await expect(owner.close()).rejects.toMatchObject({
			code: "backend-failure",
		});
		expect(worker.terminateCalls).toBe(1);
	});

	test("a close post failure drains held preserved host work before terminating once", async () => {
		const hostStarted = deferred<void>();
		const releaseHost = deferred<void>();
		const events: string[] = [];
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () =>
					host.request({ type: "attachmentDownloadSinkRuntimeScope" }),
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostStarted.resolve();
				await releaseHost.promise;
				events.push("host-drained");
				return "done";
			},
			preserveHostRequestDuringClose: () => true,
			beforeWorkerTerminate: async () => {
				events.push("before-terminate");
			},
		});
		const request = owner.channel("runtime").request({});
		void request.catch(() => undefined);
		await hostStarted.promise;
		worker.nextPostFailure = new Error("close post failed");
		let closeSettled = false;
		const close = owner.close().catch((error: unknown) => {
			closeSettled = true;
			return error;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		expect(worker.terminateCalls).toBe(0);
		releaseHost.resolve();
		await expect(close).resolves.toMatchObject({ code: "backend-failure" });
		expect(events).toEqual(["host-drained", "before-terminate"]);
		expect(worker.terminateCalls).toBe(1);
		await expect(owner.close()).rejects.toMatchObject({
			code: "backend-failure",
		});
		expect(worker.terminateCalls).toBe(1);
	});

	test("general Worker failure waits for a non-cooperative host handler before terminating", async () => {
		const hostStarted = deferred<void>();
		const releaseHost = deferred<void>();
		const events: string[] = [];
		let aborted = false;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: { request: async () => host.request({ type: "ordinary" }) },
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (_payload, signal) => {
				hostStarted.resolve();
				signal.addEventListener("abort", () => {
					aborted = true;
				});
				await releaseHost.promise;
				events.push("handler-released");
				return "late";
			},
			beforeWorkerTerminate: async () => {
				events.push("before-terminate");
			},
		});
		const request = owner.channel("runtime").request({});
		await hostStarted.promise;
		worker.fail("general failure");
		await expect(request).rejects.toMatchObject({ code: "backend-failure" });
		expect(aborted).toBe(true);
		expect(worker.terminateCalls).toBe(0);
		releaseHost.resolve();
		await expect(owner.close()).rejects.toMatchObject({
			code: "backend-failure",
		});
		expect(events).toEqual(["handler-released", "before-terminate"]);
		expect(worker.terminateCalls).toBe(1);
	});

	test("Worker message deserialization failure settles and drains ownership exactly once across concurrent shutdown", async () => {
		const pendingReply = deferred<unknown>();
		const preservedStarted = deferred<void>();
		const ordinaryStarted = deferred<void>();
		const releasePreserved = deferred<void>();
		const releaseOrdinary = deferred<void>();
		const events: string[] = [];
		let ordinaryAborted = false;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async (payload) => {
					const kind = (payload as { kind: string }).kind;
					if (kind === "pending") return pendingReply.promise;
					return host.request({ kind });
				},
			},
		}));
		worker.onTerminate = () => events.push("terminated");
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async (payload, signal) => {
				const kind = (payload as { kind: string }).kind;
				if (kind === "preserved") {
					preservedStarted.resolve();
					await releasePreserved.promise;
					events.push("preserved-drained");
					return "preserved";
				}
				ordinaryStarted.resolve();
				signal.addEventListener("abort", () => {
					ordinaryAborted = true;
				});
				await releaseOrdinary.promise;
				events.push("ordinary-drained");
				return "ordinary";
			},
			preserveHostRequestDuringClose: (payload) =>
				(payload as { kind?: string }).kind === "preserved",
			beforeWorkerTerminate: async () => {
				events.push("before-terminate");
			},
		});
		const requests = [
			owner.channel("runtime").request({ kind: "pending" }),
			owner.channel("runtime").request({ kind: "preserved" }),
			owner.channel("runtime").request({ kind: "ordinary" }),
		];
		for (const request of requests) void request.catch(() => undefined);
		await Promise.all([preservedStarted.promise, ordinaryStarted.promise]);

		worker.failMessage();
		await Promise.resolve();
		for (const request of requests) {
			await expect(request).rejects.toMatchObject({ code: "backend-failure" });
		}
		expect(ordinaryAborted).toBe(true);
		expect(worker.terminateCalls).toBe(0);
		expect(worker.onmessage).not.toBeNull();
		expect(worker.onmessageerror).not.toBeNull();
		expect(worker.onerror).not.toBeNull();
		const close = owner.close();
		void close.catch(() => undefined);
		worker.fail("concurrent worker error");

		releasePreserved.resolve();
		await Promise.resolve();
		expect(worker.terminateCalls).toBe(0);
		releaseOrdinary.resolve();
		await expect(close).rejects.toMatchObject({ code: "backend-failure" });
		expect(events).toEqual([
			"preserved-drained",
			"ordinary-drained",
			"before-terminate",
			"terminated",
		]);
		expect(worker.terminateCalls).toBe(1);
		expect(worker.onmessage).toBeNull();
		expect(worker.onmessageerror).toBeNull();
		expect(worker.onerror).toBeNull();
		pendingReply.resolve("too late");
		await Promise.resolve();
		expect(events.at(-1)).toBe("terminated");
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

	test("malformed known and late host responses neither settle nor retain binary aliases", async () => {
		const hostStarted = deferred<void>();
		const releaseHost = deferred<void>();
		let settled = false;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					const answer = host.request({
						type: "attachmentUploadSource",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"read"}',
					});
					answer.finally(() => {
						settled = true;
					});
					return answer;
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostStarted.resolve();
				await releaseHost.promise;
				return { controlResponseJson: '{"type":"end"}' };
			},
		});
		const request = owner.channel("runtime").request({});
		await hostStarted.promise;

		for (const id of [0, 99]) {
			for (const kind of ["extra", "accessor", "prototype"] as const) {
				const backing = new Uint8Array([9, 1, 2, 8]);
				const valid = {
					type: "host-response",
					id,
					ok: true,
					value: {
						controlResponseJson: '{"type":"chunk"}',
						binaryChunk: new Uint8Array(backing.buffer, 1, 2),
					},
				};
				let malformed: unknown;
				if (kind === "extra") malformed = { ...valid, extra: true };
				else if (kind === "prototype") {
					malformed = Object.assign(Object.create({ hostile: true }), valid);
				} else {
					const accessor = { ...valid };
					Object.defineProperty(accessor, "ok", {
						get: () => true,
						enumerable: true,
					});
					malformed = accessor;
				}
				worker.emitToWorker(malformed);
				expect([...backing]).toEqual([0, 0, 0, 0]);
			}
		}
		await flush();
		expect(settled).toBe(false);

		releaseHost.resolve();
		expect(await request).toEqual({ controlResponseJson: '{"type":"end"}' });
	});

	test("hostile actual Uint8Array responses are wiped on known and late paths without settling or invoking accessors", async () => {
		const hostStarted = deferred<void>();
		const releaseHost = deferred<void>();
		let settled = false;
		const worker = new MultiplexWorkerDouble((host) => ({
			runtime: {
				request: async () => {
					const answer = host.request({
						type: "attachmentUploadSource",
						runtimeIncarnation: "runtime-one",
						controlRequestJson: '{"type":"read"}',
					});
					answer.finally(() => {
						settled = true;
					});
					return answer;
				},
			},
		}));
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostStarted.resolve();
				await releaseHost.promise;
				return { controlResponseJson: '{"type":"end"}' };
			},
		});
		const request = owner.channel("runtime").request({});
		await hostStarted.promise;
		for (const id of [0, 99]) {
			const hostile = hostilePlaintext([9, 1, 2, 8]);
			worker.emitToWorker({
				type: "host-response",
				id,
				ok: true,
				value: {
					controlResponseJson: '{"type":"chunk"}',
					binaryChunk: hostile.bytes,
				},
			});
			expect(hostile.getterCalls()).toBe(0);
			expect(Uint8Array.prototype.slice.call(hostile.bytes)).toEqual(
				new Uint8Array(4),
			);
		}
		await flush();
		expect(settled).toBe(false);
		releaseHost.resolve();
		expect(await request).toEqual({ controlResponseJson: '{"type":"end"}' });
	});

	test("hostile actual Uint8Array host requests are wiped before handler invocation", async () => {
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready" },
		});
		let hostCalls = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostCalls += 1;
				return "must-not-run";
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("ready");
		const hostile = hostilePlaintext([8, 7, 6, 5]);
		worker.emitToMain({
			type: "host-request",
			id: 88,
			payload: {
				type: "attachmentDownloadSink",
				runtimeIncarnation: "runtime-one",
				controlRequestJson: '{"type":"write"}',
				binaryChunk: hostile.bytes,
			},
		});
		await flush();
		expect(hostCalls).toBe(0);
		expect(hostile.getterCalls()).toBe(0);
		expect(Uint8Array.prototype.slice.call(hostile.bytes)).toEqual(
			new Uint8Array(4),
		);
	});

	test("malformed host requests wipe attached plaintext and never invoke the host", async () => {
		const worker = new MultiplexWorkerDouble({
			runtime: { request: async () => "ready" },
		});
		let hostCalls = 0;
		const owner = createSharedWorkerOwner({
			createWorker: () => worker,
			handleHostRequest: async () => {
				hostCalls += 1;
				return "must-not-run";
			},
		});
		expect(await owner.channel("runtime").request<string>({})).toBe("ready");
		for (const kind of ["extra", "accessor"] as const) {
			const backing = new Uint8Array([7, 6, 5, 4]);
			const valid = {
				type: "host-request",
				id: 42,
				payload: {
					type: "attachmentDownloadSink",
					runtimeIncarnation: "runtime-one",
					controlRequestJson: '{"type":"write"}',
					binaryChunk: new Uint8Array(backing.buffer, 1, 2),
				},
			};
			let malformed: unknown;
			if (kind === "extra") malformed = { ...valid, extra: true };
			else {
				const accessor = { ...valid };
				Object.defineProperty(accessor, "type", {
					get: () => "host-request",
					enumerable: true,
				});
				malformed = accessor;
			}
			worker.emitToMain(malformed);
			expect([...backing]).toEqual([0, 0, 0, 0]);
		}
		for (const [index, kind] of ["extra", "accessor"].entries()) {
			const backing = new Uint8Array([8, 7, 6, 5]);
			const validPayload = {
				type: "attachmentDownloadSink",
				runtimeIncarnation: "runtime-one",
				controlRequestJson: '{"type":"write"}',
				binaryChunk: new Uint8Array(backing.buffer, 1, 2),
			};
			let payload: unknown;
			if (kind === "extra") payload = { ...validPayload, extra: true };
			else {
				const accessor = { ...validPayload };
				Object.defineProperty(accessor, "type", {
					get: () => "attachmentDownloadSink",
					enumerable: true,
				});
				payload = accessor;
			}
			worker.emitToMain({ type: "host-request", id: 50 + index, payload });
			await flush();
			expect([...backing]).toEqual([0, 0, 0, 0]);
		}
		expect(hostCalls).toBe(0);
	});

	test("a malformed close envelope never closes worker services", async () => {
		let listener!: (event: { data: unknown }) => void;
		let closeCalls = 0;
		const replies: unknown[] = [];
		serveWorkerChannels(
			{
				addEventListener: (_type, nextListener) => {
					listener = nextListener;
				},
				postMessage: (message) => replies.push(message),
			},
			{
				runtime: {
					request: async () => undefined,
					close: async () => {
						closeCalls += 1;
					},
				},
			},
		);
		const accessor = { type: "close", id: 0 };
		Object.defineProperty(accessor, "type", {
			get: () => "close",
			enumerable: true,
		});
		for (const data of [{ type: "close", id: 0, extra: true }, accessor]) {
			listener({ data });
		}
		await flush();
		expect(closeCalls).toBe(0);
		expect(replies).toEqual([]);
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

	for (const scenario of [
		{
			name: "sink scope prepare",
			payload: {
				type: "attachmentDownloadSinkRuntimeScope",
				runtimeIncarnation: "runtime-one",
				phase: "prepare",
			},
			preserve: true,
		},
		{
			name: "sink scope commit",
			payload: {
				type: "attachmentDownloadSinkRuntimeScope",
				runtimeIncarnation: "runtime-one",
				phase: "commit",
			},
			preserve: true,
		},
		{
			name: "sink lifecycle abort",
			payload: {
				type: "attachmentDownloadSink",
				runtimeIncarnation: "runtime-one",
				controlRequestJson: '{"type":"retireRuntime"}',
			},
			preserve: true,
		},
		{
			name: "Account retirement completion",
			payload: {
				type: "attachmentDownloadSink",
				runtimeIncarnation: "runtime-one",
				controlRequestJson:
					'{"type":"completeAccountRetirement","accountId":"account-one"}',
			},
			preserve: true,
		},
		{
			name: "platform metadata",
			payload: { type: "get", area: "devicePlain", key: "catalog" },
			preserve: false,
		},
		{
			name: "Session transport",
			payload: { type: "http", dispatchId: "session-refresh" },
			preserve: false,
		},
	] as const) {
		test(`close settles and drains reverse RPC during ${scenario.name}`, async () => {
			const hostStarted = deferred<void>();
			const handlerStarted = deferred<void>();
			const workerHostSettled = deferred<void>();
			const releaseHost = deferred<void>();
			let hostWait: Promise<unknown> | undefined;
			let observedCode: string | undefined;
			let aborted = false;
			let mutatedAfterClose = false;
			const worker = new MultiplexWorkerDouble((host) => ({
				runtime: {
					request: async () => {
						hostWait = host.request(scenario.payload);
						hostStarted.resolve();
						return hostWait;
					},
					close: async () => {
						try {
							await hostWait;
						} catch (error) {
							observedCode = (error as { code?: string }).code;
						} finally {
							workerHostSettled.resolve();
						}
					},
				},
			}));
			const owner = createSharedWorkerOwner({
				createWorker: () => worker,
				handleHostRequest: async (_payload, signal) => {
					handlerStarted.resolve();
					signal.addEventListener("abort", () => {
						aborted = true;
					});
					await releaseHost.promise;
					if (!signal.aborted) mutatedAfterClose = true;
					return "settled";
				},
				preserveHostRequestDuringClose: (payload) =>
					isAttachmentDownloadSinkHostRequest(payload) ||
					isAttachmentDownloadSinkRuntimeScopeRequest(payload),
			});
			const request = owner.channel("runtime").request({});
			void request.catch(() => undefined);
			await hostStarted.promise;
			await handlerStarted.promise;
			let closeSettled = false;
			const close = owner.close().then(() => {
				closeSettled = true;
			});
			await Promise.resolve();
			expect(closeSettled).toBe(false);
			expect(aborted).toBe(!scenario.preserve);
			if (!scenario.preserve) {
				await workerHostSettled.promise;
				expect(observedCode).toBe("closed");
			}
			releaseHost.resolve();
			await close;
			expect(worker.terminateCalls).toBe(1);
			expect(mutatedAfterClose).toBe(scenario.preserve);
		});
	}

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
