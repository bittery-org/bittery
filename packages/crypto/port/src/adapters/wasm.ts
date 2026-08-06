/**
 * The extension's crypto adapter: a `CryptoPort` directly over `@bittery/crypto-wasm`, on
 * the main thread. A Manifest V3 background service worker has no worker of its own to
 * push crypto onto — it *is* the main thread — so there is no `postMessage`, no wire
 * format, and a `KeyRef` maps straight onto the WASM key-table handle it stands for via
 * `createKeyRefTable`, the same handle web's worker keeps one thread away.
 *
 * ## What's shared with `wasm-worker`, and why
 *
 * S5's worker adapter and this one bind the identical `@bittery/crypto-wasm` package, so
 * argument order, base64 boundaries, the JSON envelope shapes (`encryptVaultKeyWithMuk`,
 * key rotation) and error translation are the same problem twice. That marshalling —
 * `createCryptoWasmBackend`, the `CryptoWasm` binding surface, `classify`, and the
 * load-once-retry-on-failure rule (`memoizedBackendLoader`) — lives in
 * `../wasm-crypto-backend` and is reused here verbatim, not copied.
 *
 * What is **not** shared is the walk that turns a `KeyRef` into that backend's `bigint`
 * and back. `wasm-worker.ts`'s `Wire`/`WireArgs` encode a second constraint this adapter
 * does not have — every value must survive `structuredClone` across a thread boundary — so
 * reusing them here would mean either satisfying a constraint that serves no purpose or
 * quietly weakening what they guarantee for the worker. `toHandle`/`fromHandle` below are
 * the same walk with that constraint dropped: classify by shape, swap a `KeyRef` for its
 * handle on the way in, mint a fresh `KeyRef` for a handle on the way out.
 *
 * ## Surviving a service-worker restart
 *
 * MV3 tears the background context down and rebuilds it whenever the browser wants the
 * memory back, and the extension's old adapter (`apps/extension/src/lib/wasm-crypto.ts`)
 * dealt with this by having every exported function call `autoInit()` first ("WASM needs
 * to be initialized on each wake from idle"). There is nothing extra to do for that here:
 * every module-level variable this file owns lives inside the closure `createWasmCryptoPort`
 * returns, so a restart simply means the whole module — and this closure — is created
 * fresh next time something calls it, exactly as `apps/extension/src/background/services/
 * service-worker-lifecycle.ts` already does at wake. `initialize` is an ordinary forwarded
 * member for the same reason `wasm-worker.ts` treats it as one: `call()` loads the backend
 * before dispatching *any* member, so there is nothing `initialize` needs to do beyond
 * that a caller couldn't already get by calling any other member first — and a failed load
 * is never memoised (`memoizedBackendLoader`), so the next call retries rather than being
 * poisoned for whatever remains of this instance's life.
 *
 * ## decryptMany
 *
 * There is no round trip to amortise here, so it stays what `createCryptoWasmBackend`
 * already makes it: a straightforward loop over the WASM decrypt-handle calls, one per
 * item. Nothing in this file adds batching on top.
 */

import type { CryptoPort, KeyRef } from "../crypto-port";
import { CryptoPortError } from "../errors";
import { createKeyRefTable, type KeyRefTable } from "../key-ref";
import {
	classify,
	type LoadCryptoWasm,
	loadCryptoWasm,
	memoizedBackendLoader,
} from "../wasm-crypto-backend";

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

// ============================================================================
// Walking values between KeyRef and the WASM handle it stands for
// ============================================================================

function isPlainObject(value: object): boolean {
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

/**
 * Swap every `KeyRef` for the handle it stands for. Classified by shape, exactly as
 * `wasm-worker.ts` does on the way to `postMessage` — a `Uint8Array` passes through
 * untouched (this is how `importKey`'s raw bytes reach the backend), and anything that is
 * an object but neither an array nor a plain object is a `KeyRef`, so a foreign or
 * destroyed one throws here, before the backend ever sees the call.
 */
function toHandle(keys: KeyRefTable<bigint>, value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (value instanceof Uint8Array) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => toHandle(keys, item));
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, member]) => [
				key,
				toHandle(keys, member),
			]),
		);
	}
	return keys.read(value as KeyRef);
}

/** Mint a fresh `KeyRef` for every handle in a backend result; everything else is itself. */
function fromHandle(keys: KeyRefTable<bigint>, value: unknown): unknown {
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
		return value.map((item) => fromHandle(keys, item));
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, member]) => [
			key,
			fromHandle(keys, member),
		]),
	);
}

// ============================================================================
// The adapter
// ============================================================================

/** How the WASM module is obtained. `wasm-test-doubles.ts` hands over an in-process one. */
export interface WasmCryptoPortDeps {
	loadCryptoWasm: LoadCryptoWasm;
}

const DEFAULT_DEPS: WasmCryptoPortDeps = { loadCryptoWasm };

export function createWasmCryptoPort(
	deps: WasmCryptoPortDeps = DEFAULT_DEPS,
): CryptoPort {
	const keys = createKeyRefTable<bigint>();
	const ensureBackend = memoizedBackendLoader(deps.loadCryptoWasm);

	async function call(
		method: keyof CryptoPort,
		args: readonly unknown[],
	): Promise<unknown> {
		// Resolved before the backend is touched, so a foreign or destroyed `KeyRef`
		// throws — already a `CryptoPortError`, straight from the key table — without
		// paying for a WASM load it was never going to need.
		const handled = args.map((arg) => toHandle(keys, arg));
		try {
			const backend = await ensureBackend();
			const member = backend[method] as unknown as (
				...args: readonly unknown[]
			) => Promise<unknown>;
			return fromHandle(keys, await member(...handled));
		} catch (error) {
			// A WASM load failure or a raw backend throw, translated the same way
			// `wasm.worker.ts` does before it ever crosses a `postMessage` — there is no
			// wire here, but the vocabulary crossing this seam has to be identical.
			const { code, message } = classify(error);
			throw new CryptoPortError(code, message, { cause: error });
		}
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

		// Ref *lifetime* is owned here, not by the backend, and `destroyKey` must stay
		// idempotent — which the generic path can't do, since it throws on a destroyed ref
		// by design. `dispose` returns `null` for an already-destroyed ref, so a second call
		// never reaches the backend at all.
		async destroyKey(key) {
			const handle = keys.dispose(key);
			if (handle === null) {
				return;
			}
			try {
				const backend = await ensureBackend();
				await backend.destroyKey(handle);
			} catch (error) {
				const { code, message } = classify(error);
				throw new CryptoPortError(code, message, { cause: error });
			}
		},
	};
}
