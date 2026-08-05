/**
 * Web's crypto adapter: a `CryptoPort` on the main thread, one worker below it.
 *
 * Because the port is **total** there is nothing to enumerate. Every member marshals the
 * same way — take the arguments, send them, wait for the answer — so this adapter is one
 * generic `(method, args)` forward rather than 39 hand-written message types on each side.
 * `FORWARDED_MEMBERS` is the only list, it is data rather than logic, and the compiler
 * checks it against `keyof CryptoPort` in both directions: a name that no longer exists
 * fails the `satisfies`, and a member the port grows fails `EveryMemberIsForwarded`.
 *
 * ## Key material never reaches this thread
 *
 * A `KeyRef` here is an identity token minted by `createKeyRefTable`, and the payload it
 * maps to is a `bigint` — the WASM key-table handle, which is where the bytes actually
 * live. `toWire` swaps a ref for its handle on the way in and `fromWire` mints a ref for
 * every handle on the way out, both by walking the value generically, so no member has to
 * remember to do it. Two consequences worth stating:
 *
 *   - `toWire` classifies by shape and treats anything that is not a primitive, an array,
 *     a `Uint8Array` or a plain object as a `KeyRef`, which means it hands it to the table.
 *     A foreign ref therefore throws `invalid-key-ref` and a destroyed one `key-destroyed`
 *     **before** anything is posted, and no unrecognised object can reach `postMessage`.
 *   - A handle crosses as a `bigint` rather than as a tagged wrapper. Nothing else on the
 *     port is a `bigint`, so the encoding needs no marker and no shared constant, and it
 *     lands on WASM's own `u64` handle type without a conversion step.
 *
 * The one member that is not a plain forward is `destroyKey`, because ref *lifetime* is
 * owned here rather than in the worker: it has to retire the ref locally, and it has to
 * stay idempotent, which the generic path cannot do because that path throws on a
 * destroyed ref by design.
 *
 * `exportKey` is the single member whose reply carries bytes, and
 * `OnlyExportKeyCrossesWithBytes` below makes the compiler say so.
 */

import type { CryptoPort, KeyRef } from "../crypto-port";
import { CryptoPortError, type CryptoPortErrorCode } from "../errors";
import { createKeyRefTable } from "../key-ref";

// ============================================================================
// The wire
// ============================================================================

/**
 * A port value as it crosses `postMessage`: a `KeyRef` becomes the worker's key-table
 * handle and everything else is itself. `Uint8Array` is matched before `object` so a
 * mapped type is never spread over a typed array's methods.
 */
export type Wire<T> = T extends KeyRef
	? bigint
	: T extends Uint8Array
		? Uint8Array
		: T extends object
			? { [K in keyof T]: Wire<T[K]> }
			: T;

/** `Wire` over an argument tuple, position by position. */
export type WireArgs<T extends readonly unknown[]> = {
	[K in keyof T]: Wire<T[K]>;
};

/**
 * What the worker must implement: `CryptoPort`, with handles where the refs were.
 *
 * Derived from `CryptoPort` rather than written out, so the worker cannot fall behind the
 * port — adding a member breaks the worker's compile, not its runtime.
 */
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

/**
 * One inbound answer. A failure crosses as a code plus a message rather than as an
 * `Error`: the structured clone of a thrown value is unreliable across engines, and the
 * closed code set is what callers above the seam actually branch on.
 */
export type CryptoPortReply =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; code: CryptoPortErrorCode; message: string };

// ============================================================================
// What the compiler checks
// ============================================================================

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

/**
 * Fails to compile when a member gains an argument or a result `postMessage` cannot carry
 * — a `Date`, a `Map`, a class instance, a function. Cheaper to learn here than from a
 * `DataCloneError` in a browser.
 */
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

/**
 * The deliberate hole, held open by the compiler: `exportKey` is the only member whose
 * answer carries raw key bytes back to this thread. Everything else stays behind a handle
 * for its whole life, which is the property web's `KeyRef` exists for.
 */
export type OnlyExportKeyCrossesWithBytes = [MemberCrossingWithBytes] extends [
	"exportKey",
]
	? true
	: [
			"a member other than exportKey returns key bytes",
			MemberCrossingWithBytes,
		];

export const onlyExportKeyCrossesWithBytes: OnlyExportKeyCrossesWithBytes = true;

// ============================================================================
// The worker, as this adapter uses it
// ============================================================================

/**
 * The slice of the `Worker` global this adapter touches, declared structurally so a test
 * can supply an in-process double. A real `Worker` satisfies it.
 */
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

// ============================================================================
// Walking values across the boundary
// ============================================================================

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

// ============================================================================
// The adapter
// ============================================================================

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: CryptoPortError) => void;
}

export function createWasmWorkerCryptoPort(
	deps: WasmWorkerDeps = DEFAULT_DEPS,
): CryptoPort {
	const keys = createKeyRefTable<bigint>();
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
		// The port carries data and key references and nothing else, so an object of any
		// other shape is a ref — and the table is what says whether it is ours, was ours
		// until it was destroyed, or was never ours at all.
		return keys.read(value as KeyRef);
	}

	function fromWire(value: unknown): unknown {
		if (typeof value === "bigint") {
			return keys.create(value);
		}
		if (typeof value !== "object" || value === null) {
			return value;
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

	// `EveryMemberIsForwarded` has already proven the list covers `keyof CryptoPort`, which
	// is what makes the assertion safe — every member is the same three lines, so there is
	// nothing left for the compiler to check one by one.
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
