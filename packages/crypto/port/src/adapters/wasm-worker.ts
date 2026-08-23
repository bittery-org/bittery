import type { CryptoPort, KeyRef } from "../crypto-port";
import {
	CRYPTO_PORT_ERROR_CODES,
	CryptoPortError,
	type CryptoPortErrorCode,
} from "../errors";
import { createKeyRefTable } from "../key-ref";
import { CRYPTO_PORT_MEMBERS } from "../port-members";
import {
	createSharedWorkerOwner,
	type SharedWorkerHandle,
	type SharedWorkerOwner,
	type WorkerRpcChannel,
	type WorkerRpcError,
} from "../shared-worker-rpc";

/** KeyRefs cross `postMessage` as worker tokens; raw import bytes remain `Uint8Array`. */
export interface WorkerKeyToken {
	readonly __bitteryWorkerKey: number;
}

export type Wire<T> = T extends KeyRef
	? WorkerKeyToken
	: T extends Uint8Array
		? Uint8Array
		: T extends object
			? { [K in keyof T]: Wire<T[K]> }
			: T;

/** `Wire` over an argument tuple, position by position. */
export type WireArgs<T extends readonly unknown[]> = {
	[K in keyof T]: Wire<T[K]>;
};

/** A `CryptoPort`-shaped worker backend whose key-bearing values use worker tokens. */
export type WasmWorkerBackend = {
	[K in keyof CryptoPort]: (
		...args: WireArgs<Parameters<CryptoPort[K]>>
	) => Promise<Wire<Awaited<ReturnType<CryptoPort[K]>>>>;
};

/** One outbound call. `args` is already in wire form. */
export interface CryptoPortCall {
	method: keyof CryptoPort;
	args: readonly unknown[];
}

type UnforwardedMember = Exclude<
	keyof CryptoPort,
	(typeof CRYPTO_PORT_MEMBERS)[number]
>;

/** Fails to compile when the port grows a member this adapter does not forward. */
export type EveryMemberIsForwarded = [UnforwardedMember] extends [never]
	? true
	: ["port member missing from CRYPTO_PORT_MEMBERS", UnforwardedMember];

export const everyMemberIsForwarded: EveryMemberIsForwarded = true;

/** Everything the structured clone algorithm carries that this seam actually uses. */
type StructuredCloneable =
	| undefined
	| null
	| string
	| number
	| boolean
	| bigint
	| WorkerKeyToken
	| Uint8Array
	| readonly StructuredCloneable[]
	| { readonly [key: string]: StructuredCloneable };

/** A `void` resolution carries nothing, so it is excluded rather than described. */
type SurvivesPostMessage<T> = [Exclude<T, void>] extends [StructuredCloneable]
	? true
	: false;

type UncloneableMember = {
	[K in keyof CryptoPort]: SurvivesPostMessage<
		WireArgs<Parameters<CryptoPort[K]>>
	> extends true
		? SurvivesPostMessage<Wire<Awaited<ReturnType<CryptoPort[K]>>>> extends true
			? never
			: K
		: K;
}[keyof CryptoPort];

/** Compile-time guard against values that structured clone cannot carry. */
export type EveryPortValueSurvivesPostMessage = [UncloneableMember] extends [
	never,
]
	? true
	: ["value cannot cross postMessage", UncloneableMember];

export const everyPortValueSurvivesPostMessage: EveryPortValueSurvivesPostMessage = true;

type MemberCrossingWithBytes = {
	[K in keyof CryptoPort]: Uint8Array extends Wire<
		Awaited<ReturnType<CryptoPort[K]>>
	>
		? K
		: never;
}[keyof CryptoPort];

/** Compile-time guard that only `exportKey` returns raw key bytes to this thread. */
export type OnlyExportKeyCrossesWithBytes = [MemberCrossingWithBytes] extends [
	"exportKey",
]
	? true
	: [
			"a member other than exportKey returns key bytes",
			MemberCrossingWithBytes,
		];

export const onlyExportKeyCrossesWithBytes: OnlyExportKeyCrossesWithBytes = true;

/** A structural Worker slice lets tests supply an in-process double. */
export interface CryptoWorkerHandle extends SharedWorkerHandle {}

/** How the worker is obtained. `wasm-worker-test-doubles.ts` passes an in-process one. */
export interface WasmWorkerDeps {
	createWorker: () => CryptoWorkerHandle;
	handleHostRequest?: (
		payload: unknown,
		signal: AbortSignal,
	) => Promise<unknown>;
}

const DEFAULT_DEPS: WasmWorkerDeps = {
	createWorker: () =>
		new Worker(new URL("../wasm.worker.ts", import.meta.url), {
			type: "module",
		}),
};

export function createWasmWorkerOwner(
	deps: WasmWorkerDeps = DEFAULT_DEPS,
): SharedWorkerOwner {
	return createSharedWorkerOwner(deps);
}

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

function isWorkerKeyToken(value: object): value is WorkerKeyToken {
	return (
		Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).length === 1 &&
		typeof (value as Partial<WorkerKeyToken>).__bitteryWorkerKey === "number"
	);
}

function isWorkerRpcChannel(
	value: WasmWorkerDeps | WorkerRpcChannel,
): value is WorkerRpcChannel {
	return "request" in value && typeof value.request === "function";
}

export function createWasmWorkerCryptoPort(
	channelOrDeps: WorkerRpcChannel | WasmWorkerDeps = DEFAULT_DEPS,
): CryptoPort {
	const keys = createKeyRefTable<WorkerKeyToken>();
	const channel = isWorkerRpcChannel(channelOrDeps)
		? channelOrDeps
		: createWasmWorkerOwner(channelOrDeps).channel("crypto");

	function toWire(value: unknown): unknown {
		if (typeof value !== "object" || value === null) {
			return value;
		}
		if (value instanceof Uint8Array) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(toWire);
		}
		if (isPlainObject(value)) {
			return Object.fromEntries(
				Object.entries(value).map(([key, member]) => [key, toWire(member)]),
			);
		}
		// Only refs use non-plain object shapes, so the table validates their ownership.
		return keys.read(value as KeyRef);
	}

	function fromWire(value: unknown): unknown {
		if (typeof value !== "object" || value === null) {
			return value;
		}
		if (isWorkerKeyToken(value)) {
			return keys.create(value);
		}
		if (value instanceof Uint8Array) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(fromWire);
		}
		return Object.fromEntries(
			Object.entries(value).map(([key, member]) => [key, fromWire(member)]),
		);
	}

	async function call(
		method: keyof CryptoPort,
		args: readonly unknown[],
	): Promise<unknown> {
		const wire = args.map(toWire);
		try {
			return fromWire(
				await channel.request({
					method,
					args: wire,
				} satisfies CryptoPortCall),
			);
		} catch (error) {
			const rpcError = error as WorkerRpcError;
			const code = CRYPTO_PORT_ERROR_CODES.includes(
				rpcError.code as CryptoPortErrorCode,
			)
				? (rpcError.code as CryptoPortErrorCode)
				: "backend-failure";
			throw new CryptoPortError(
				code,
				error instanceof Error ? error.message : "The crypto worker failed.",
				{ cause: error },
			);
		}
	}

	const forwarded = Object.fromEntries(
		CRYPTO_PORT_MEMBERS.map((member) => [
			member,
			(...args: readonly unknown[]) => call(member, args),
		]),
	) as unknown as CryptoPort;

	return {
		...forwarded,

		async destroyKey(key) {
			const handle = keys.dispose(key);
			if (handle === null) {
				return;
			}
			await call("destroyKey", [handle]);
		},
	};
}
