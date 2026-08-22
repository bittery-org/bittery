import type { KeyHandleLike } from "@bittery/crypto-wasm";
import type { KeyRef } from "../crypto-port";
import type { CryptoPortErrorCode } from "../errors";
import { createInMemoryCryptoPort } from "../testing/in-memory-crypto";
import type { UniffiBackend } from "../uniffi-bindings";
import type { CryptoWorkerScope } from "../wasm.worker";
import { serveCryptoPort } from "../wasm.worker";
import type {
	CryptoPortCall,
	CryptoWorkerHandle,
	WasmWorkerDeps,
} from "./wasm-worker";

type CryptoReplyObservation =
	| { method: CryptoPortCall["method"]; ok: true; value: unknown }
	| {
			method: CryptoPortCall["method"];
			ok: false;
			code: CryptoPortErrorCode;
			message: string;
	  };

class KeyHandleDouble implements KeyHandleLike {
	constructor(readonly ref: KeyRef) {}

	async destroy(): Promise<void> {}
}

export type CryptoWasmDouble = UniffiBackend<KeyHandleLike> & {
	readonly liveHandleCount: number;
	readonly destroyCalls: number;
	nextUuidFailure: unknown;
};

function createCryptoWasmDouble(): CryptoWasmDouble {
	const port = createInMemoryCryptoPort();
	const live = new Set<KeyHandleDouble>();
	let nextUuidFailure: unknown = null;
	let destroyCalls = 0;

	function toPort(value: unknown): unknown {
		if (value instanceof KeyHandleDouble) {
			return value.ref;
		}
		if (value instanceof Uint8Array) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(toPort);
		}
		if (typeof value === "object" && value !== null) {
			return Object.fromEntries(
				Object.entries(value).map(([key, member]) => [key, toPort(member)]),
			);
		}
		return value;
	}

	function fromPort(value: unknown): unknown {
		if (value instanceof Uint8Array) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(fromPort);
		}
		if (typeof value !== "object" || value === null) {
			return value;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype) {
			const handle = new KeyHandleDouble(value as KeyRef);
			live.add(handle);
			return handle;
		}
		return Object.fromEntries(
			Object.entries(value).map(([key, member]) => [key, fromPort(member)]),
		);
	}

	return new Proxy({} as CryptoWasmDouble, {
		get(_target, property) {
			if (property === "liveHandleCount") {
				return live.size;
			}
			if (property === "nextUuidFailure") {
				return nextUuidFailure;
			}
			if (property === "destroyCalls") {
				return destroyCalls;
			}
			if (property === "then") {
				return undefined;
			}
			return async (...args: readonly unknown[]) => {
				if (property === "generateUuid" && nextUuidFailure !== null) {
					const failure = nextUuidFailure;
					nextUuidFailure = null;
					throw failure;
				}
				const member = port[property as keyof typeof port] as unknown as (
					...values: readonly unknown[]
				) => Promise<unknown>;
				const value = await member.apply(port, args.map(toPort));
				if (property === "destroyKey") {
					destroyCalls += 1;
					live.delete(args[0] as KeyHandleDouble);
				}
				return fromPort(value);
			};
		},
		set(_target, property, value) {
			if (property !== "nextUuidFailure") {
				return false;
			}
			nextUuidFailure = value;
			return true;
		},
	});
}

export class WorkerDouble implements CryptoWorkerHandle {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	readonly calls: CryptoPortCall[] = [];
	readonly replies: CryptoReplyObservation[] = [];
	holdReplies = false;
	terminateCalls = 0;

	private readonly held: unknown[] = [];
	private readonly cryptoCallsByRpcId = new Map<number, CryptoPortCall>();
	private listener: ((event: { data: unknown }) => void) | null = null;

	constructor(loadBackend: () => Promise<UniffiBackend<KeyHandleLike>>) {
		const scope: CryptoWorkerScope = {
			addEventListener: (_type, listener) => {
				this.listener = listener;
			},
			postMessage: (message) => this.answer(structuredClone(message)),
		};
		serveCryptoPort(scope, loadBackend);
	}

	postMessage(message: unknown): void {
		const envelope = structuredClone(message) as {
			type?: string;
			channel?: string;
			id?: number;
			payload?: unknown;
		};
		if (
			envelope.type === "request" &&
			envelope.channel === "crypto" &&
			typeof envelope.id === "number"
		) {
			const call = envelope.payload as CryptoPortCall;
			this.calls.push(call);
			this.cryptoCallsByRpcId.set(envelope.id, call);
		}
		const listener = this.listener;
		queueMicrotask(() => listener?.({ data: envelope }));
	}

	terminate(): void {
		this.terminateCalls += 1;
	}

	releaseHeldReplies(order: "as-received" | "reverse" = "as-received"): void {
		this.holdReplies = false;
		const released = order === "reverse" ? this.held.toReversed() : this.held;
		for (const reply of released) {
			this.deliver(reply);
		}
		this.held.length = 0;
	}

	fail(message: string): void {
		this.onerror?.(new ErrorEvent("error", { message }));
	}

	callsTo(method: string): CryptoPortCall[] {
		return this.calls.filter((call) => call.method === method);
	}

	private answer(message: unknown): void {
		const envelope = message as {
			type?: string;
			id?: number;
			ok?: boolean;
			value?: unknown;
			code?: CryptoPortErrorCode;
			message?: string;
		};
		if (envelope.type === "response" && typeof envelope.id === "number") {
			const call = this.cryptoCallsByRpcId.get(envelope.id);
			if (call !== undefined) {
				this.replies.push(
					envelope.ok
						? { method: call.method, ok: true, value: envelope.value }
						: {
								method: call.method,
								ok: false,
								code: envelope.code ?? "backend-failure",
								message: envelope.message ?? "The crypto worker failed.",
							},
				);
				this.cryptoCallsByRpcId.delete(envelope.id);
			}
		}
		if (this.holdReplies) {
			this.held.push(message);
			return;
		}
		this.deliver(message);
	}

	private deliver(message: unknown): void {
		this.onmessage?.(new MessageEvent("message", { data: message }));
	}
}

export interface WasmWorkerDoubles {
	deps: WasmWorkerDeps;
	wasm: CryptoWasmDouble;
	worker: WorkerDouble;
	readonly workersCreated: number;
	readonly wasmLoads: number;
}

export interface WasmWorkerDoublesOptions {
	wasmFailure?: unknown;
}

export function createWasmWorkerDoubles(
	options: WasmWorkerDoublesOptions = {},
): WasmWorkerDoubles {
	const wasm = createCryptoWasmDouble();
	let wasmLoads = 0;
	let workersCreated = 0;
	const worker = new WorkerDouble(async () => {
		wasmLoads += 1;
		if (options.wasmFailure !== undefined) {
			throw options.wasmFailure;
		}
		return wasm;
	});

	return {
		deps: {
			createWorker: () => {
				workersCreated += 1;
				return worker;
			},
		},
		wasm,
		worker,
		get workersCreated() {
			return workersCreated;
		},
		get wasmLoads() {
			return wasmLoads;
		},
	};
}
