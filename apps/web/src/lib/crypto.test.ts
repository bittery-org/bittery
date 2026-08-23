import { expect, test } from "bun:test";
import type { CryptoWorkerHandle } from "@bittery/crypto-port/adapters/wasm-worker";
import { createWebWorkerComposition } from "./crypto";

class UnifiedWorkerDouble implements CryptoWorkerHandle {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	terminateCalls = 0;

	postMessage(message: unknown): void {
		const request = message as {
			type: string;
			channel: string;
			id: number;
			payload: unknown;
		};
		if (request.type === "close") {
			queueMicrotask(() =>
				this.onmessage?.(
					new MessageEvent("message", {
						data: { type: "close-ack", id: request.id, ok: true },
					}),
				),
			);
			return;
		}
		if (request.type !== "request") return;
		const command = request.payload as {
			type?: string;
			observationId?: string;
		};
		if (request.channel === "runtime" && command.type === "observe") {
			queueMicrotask(() =>
				this.onmessage?.(
					new MessageEvent("message", {
						data: {
							type: "notification",
							channel: "runtime",
							value: {
								type: "observation",
								observationId: command.observationId,
								projectionJson: "cold-projection",
							},
						},
					}),
				),
			);
		}
		const value = request.channel === "runtime" ? "cold-result" : undefined;
		queueMicrotask(() =>
			this.onmessage?.(
				new MessageEvent("message", {
					data: {
						type: "response",
						channel: request.channel,
						id: request.id,
						ok: true,
						value,
					},
				}),
			),
		);
	}

	terminate(): void {
		this.terminateCalls += 1;
	}
}

test("Web composes cold Crypto and Runtime facades over exactly one worker", async () => {
	const worker = new UnifiedWorkerDouble();
	let workersCreated = 0;
	const composition = createWebWorkerComposition({
		createWorker: () => {
			workersCreated += 1;
			return worker;
		},
	});

	await composition.crypto.initialize();
	const result = await composition.runtime.request("cold", "{}");
	const observations: string[] = [];
	await composition.runtime.observe("vault", "{}", (value) =>
		observations.push(value),
	);

	expect(result).toBe("cold-result");
	expect(observations).toEqual(["cold-projection"]);
	expect(workersCreated).toBe(1);
	await Promise.all([composition.runtime.close(), composition.runtime.close()]);
	expect(worker.terminateCalls).toBe(1);
});

test("Web preserves a custom reverse-RPC host handler", async () => {
	const worker = new UnifiedWorkerDouble();
	const seen: unknown[] = [];
	const composition = createWebWorkerComposition({
		createWorker: () => worker,
		handleHostRequest: async (payload) => {
			seen.push(payload);
			return "custom-result";
		},
	});
	const hostReplies: unknown[] = [];
	worker.postMessage = (message: unknown) => {
		const request = message as { type?: string; id?: number; value?: unknown };
		if (request.type === "request") {
			queueMicrotask(() => {
				worker.onmessage?.(
					new MessageEvent("message", {
						data: {
							type: "host-request",
							id: 17,
							payload: '{"type":"get"}',
						},
					}),
				);
			});
			return;
		}
		if (request.type === "host-response") {
			hostReplies.push(request);
			queueMicrotask(() => {
				worker.onmessage?.(
					new MessageEvent("message", {
						data: {
							type: "response",
							channel: "runtime",
							id: 0,
							ok: true,
							value: request.value,
						},
					}),
				);
			});
		}
	};

	expect(await composition.runtime.request("host", "{}")).toBe("custom-result");
	expect(seen).toEqual(['{"type":"get"}']);
	expect(hostReplies).toEqual([
		{
			type: "host-response",
			id: 17,
			ok: true,
			value: "custom-result",
		},
	]);
});
