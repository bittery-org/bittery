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
		if (request.type !== "request") return;
		const value =
			request.channel === "runtime"
				? { shadow: true, payload: request.payload }
				: undefined;
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

test("Web composes crypto and a Runtime shadow channel over one worker owner", async () => {
	const worker = new UnifiedWorkerDouble();
	let workersCreated = 0;
	const composition = createWebWorkerComposition({
		createWorker: () => {
			workersCreated += 1;
			return worker;
		},
	});

	await composition.crypto.initialize();
	const shadow = await composition.workerOwner
		.channel("runtime")
		.request<{ shadow: boolean; payload: { operation: string } }>({
			operation: "shadow-only",
		});

	expect(shadow).toEqual({
		shadow: true,
		payload: { operation: "shadow-only" },
	});
	expect(workersCreated).toBe(1);
});
