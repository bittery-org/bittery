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
