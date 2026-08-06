/**
 * The crypto worker: the only place on web where key material exists.
 *
 * It serves one generic `(method, args)` request. There is no dispatch table and no
 * message type per operation — `WasmWorkerBackend` is derived from `CryptoPort`, so the
 * backend is checked member for member by the compiler and the loop that drives it is
 * four lines. Adding a member to the port breaks this file's build rather than its
 * behaviour.
 *
 * The `@bittery/crypto-wasm` binding surface and the marshalling onto it
 * (`createCryptoWasmBackend`) live in `./wasm-crypto-backend`, shared with the extension's
 * same-thread adapter (`adapters/wasm.ts`) — both bind the identical package and both key
 * a `CryptoPort` by the WASM handle a `KeyRef` stands for. This file's own job is only the
 * worker-specific half: the serving loop, and the entry point that starts it.
 *
 * ## Why the keys stay here
 *
 * Every key argument arrives as a `bigint` — a WASM key-table handle — and every key
 * result leaves as one. The type says so: `WireArgs`/`Wire` (in `./adapters/wasm-worker`)
 * replace `KeyRef` with `bigint` everywhere, so a member *cannot* be written to accept or
 * return bytes. Several WASM functions do take a base64 key (`encryptVaultKeyWithMUK`,
 * `encryptVaultKeyForMember`, `performKeyRotation`, `reEncryptItem`, `encryptMasterKey`,
 * and the wrapping key of `encryptKeyHandleWithKey`), and the `exportKeyHandle` that feeds
 * them happens **inside `createCryptoWasmBackend`**, where the bytes never see a
 * `postMessage`. The single exception is `exportKey` itself, which exists so a platform
 * can persist its own device key.
 */

import type { CryptoPortCall, CryptoPortReply } from "./adapters/wasm-worker";
import type {
	CryptoWasm,
	LoadCryptoWasm,
	WasmAadContext,
	WasmDerivedKeyHandles,
	WasmEncryptedData,
	WasmItemData,
	WasmKeyRotationResult,
	WasmPasskeyAssertion,
	WasmPasskeyAttestation,
	WasmPasskeyKeypair,
	WasmReEncryptedItem,
	WasmRsaKeyPair,
	WasmSrpClient,
	WasmSrpEphemeral,
	WasmSrpSession,
	WasmValidationResult,
} from "./wasm-crypto-backend";
import {
	BackendFailure,
	classify,
	loadCryptoWasm,
	memoizedBackendLoader,
} from "./wasm-crypto-backend";

// Re-exported so this stays the one import path for the WASM binding surface: the test
// doubles, and any future adapter, read it from here rather than from
// `./wasm-crypto-backend` directly.
export type {
	CryptoWasm,
	LoadCryptoWasm,
	WasmAadContext,
	WasmDerivedKeyHandles,
	WasmEncryptedData,
	WasmItemData,
	WasmKeyRotationResult,
	WasmPasskeyAssertion,
	WasmPasskeyAttestation,
	WasmPasskeyKeypair,
	WasmReEncryptedItem,
	WasmRsaKeyPair,
	WasmSrpClient,
	WasmSrpEphemeral,
	WasmSrpSession,
	WasmValidationResult,
};

// ============================================================================
// The serving loop
// ============================================================================

/**
 * The slice of the worker global this file drives. Declared structurally because
 * `DedicatedWorkerGlobalScope` is not in this package's `lib`, and because a test needs
 * to stand in for it.
 */
export interface CryptoWorkerScope {
	addEventListener(
		type: "message",
		listener: (event: { data: unknown }) => void,
	): void;
	postMessage(message: unknown): void;
}

/**
 * Answer `CryptoPortCall`s on `scope` until the thread ends.
 *
 * WASM is loaded once, lazily, and a failed load is not remembered — a port whose first
 * call raced a network hiccup can be initialised again rather than being poisoned for the
 * life of the worker.
 */
export function serveCryptoPort(
	scope: CryptoWorkerScope,
	loadWasm: LoadCryptoWasm,
): void {
	const ensureBackend = memoizedBackendLoader(loadWasm);

	scope.addEventListener("message", (event) => {
		const request = event.data as CryptoPortCall;

		void (async () => {
			try {
				const ready = await ensureBackend();
				if (!Object.hasOwn(ready, request.method)) {
					throw new BackendFailure(
						"invalid-input",
						`Unknown crypto port member "${String(request.method)}".`,
					);
				}
				const member = ready[request.method] as unknown as (
					...args: readonly unknown[]
				) => Promise<unknown>;

				scope.postMessage({
					id: request.id,
					ok: true,
					value: await member(...request.args),
				} satisfies CryptoPortReply);
			} catch (error) {
				scope.postMessage({
					id: request.id,
					ok: false,
					...classify(error),
				} satisfies CryptoPortReply);
			}
		})();
	});
}

// The entry point. `globalThis` in a worker is a `DedicatedWorkerGlobalScope`, which this
// package's `lib` does not describe, so the shape is asserted rather than imported.
serveCryptoPort(globalThis as unknown as CryptoWorkerScope, loadCryptoWasm);
