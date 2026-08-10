import type { CryptoPort, KeyRef } from "../crypto-port";
import { CryptoPortError, type CryptoPortErrorCode } from "../errors";
import { createKeyRefTable } from "../key-ref";

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
	id: number;
	method: keyof CryptoPort;
	args: readonly unknown[];
}

/** Errors cross as data because structured cloning thrown values varies by engine. */
export type CryptoPortReply =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; code: CryptoPortErrorCode; message: string };

const FORWARDED_MEMBERS = [
	"initialize",
	"generateEncryptionKey",
	"importKey",
	"exportKey",
	"cloneKey",
	"destroyKey",
	"deriveKeys",
	"deriveMasterKey",
	"deriveKeysFromMasterKey",
	"deriveSrpPassword",
	"encrypt",
	"decrypt",
	"decryptMany",
	"wrapKey",
	"unwrapKey",
	"generateRsaKeyPair",
	"rsaEncrypt",
	"rsaDecrypt",
	"decryptRsaWrappedKey",
	"encryptVaultKeyForMember",
	"encryptVaultKeyWithMuk",
	"reEncryptItem",
	"performKeyRotation",
	"validateRotationData",
	"generateSecretKey",
	"validateSecretKey",
	"generateRecoveryKey",
	"validateRecoveryKey",
	"encryptMasterKey",
	"decryptMasterKey",
	"generateSrpRegistration",
	"generateClientEphemeral",
	"deriveClientSession",
	"verifyServerSession",
	"generatePasskeyKeypair",
	"generatePasskeyCredentialId",
	"buildPasskeyAttestationObject",
	"signPasskeyAssertion",
	"generateUuid",
] as const satisfies readonly (keyof CryptoPort)[];

type UnforwardedMember = Exclude<
	keyof CryptoPort,
	(typeof FORWARDED_MEMBERS)[number]
>;

/** Fails to compile when the port grows a member this adapter does not forward. */
export type EveryMemberIsForwarded = [UnforwardedMember] extends [never]
	? true
	: ["port member missing from FORWARDED_MEMBERS", UnforwardedMember];

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
export interface CryptoWorkerHandle {
	postMessage(message: unknown): void;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}

/** How the worker is obtained. `wasm-worker-test-doubles.ts` passes an in-process one. */
export interface WasmWorkerDeps {
	createWorker: () => CryptoWorkerHandle;
}

const DEFAULT_DEPS: WasmWorkerDeps = {
	createWorker: () =>
		new Worker(new URL("../wasm.worker.ts", import.meta.url), {
			type: "module",
		}),
};

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

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: CryptoPortError) => void;
}

export function createWasmWorkerCryptoPort(
	deps: WasmWorkerDeps = DEFAULT_DEPS,
): CryptoPort {
	const keys = createKeyRefTable<WorkerKeyToken>();
	const pending = new Map<number, PendingCall>();
	let worker: CryptoWorkerHandle | null = null;
	let backendFailure: CryptoPortError | null = null;
	let nextId = 0;

	function settle(event: MessageEvent): void {
		const reply = event.data as CryptoPortReply;
		const call = pending.get(reply.id);
		if (call === undefined) {
			return;
		}
		pending.delete(reply.id);
		if (reply.ok) {
			call.resolve(reply.value);
			return;
		}
		call.reject(new CryptoPortError(reply.code, reply.message));
	}

	function abandon(event: ErrorEvent): void {
		// A worker that died takes every key handle with it, so there is nothing to salvage
		// and no call that can still be answered.
		const failure = new CryptoPortError(
			"backend-failure",
			event.message.length > 0 ? event.message : "The crypto worker failed.",
		);
		const failedWorker = worker;
		worker = null;
		backendFailure = failure;
		if (failedWorker) {
			failedWorker.onmessage = null;
			failedWorker.onerror = null;
		}
		for (const call of pending.values()) {
			call.reject(failure);
		}
		pending.clear();
	}

	function ensureWorker(): CryptoWorkerHandle {
		if (backendFailure) {
			throw backendFailure;
		}
		if (worker === null) {
			worker = deps.createWorker();
			worker.onmessage = settle;
			worker.onerror = abandon;
		}
		return worker;
	}

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
		const target = ensureWorker();
		const wire = args.map(toWire);
		const id = nextId;
		nextId += 1;

		const answer = new Promise<unknown>((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
		target.postMessage({ id, method, args: wire } satisfies CryptoPortCall);

		return fromWire(await answer);
	}

	const forwarded = Object.fromEntries(
		FORWARDED_MEMBERS.map((member) => [
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
