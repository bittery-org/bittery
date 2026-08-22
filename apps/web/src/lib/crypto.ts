/**
 * The web app's crypto backend: one `CryptoPort` over one WASM worker.
 *
 * Built here rather than inside a component because `AccountStore` needs it before React
 * mounts, and because a second instance would mean a second key table — a `KeyRef` minted
 * by one port is rejected by the other.
 */

import {
	createWasmWorkerCryptoPort,
	createWasmWorkerOwner,
	type WasmWorkerDeps,
} from "@bittery/crypto-port/adapters/wasm-worker";

// This process-wide owner is the single channel multiplexer. This batch attaches only the
// existing production crypto service; Runtime remains an explicit shadow/test channel until
// its real Web ports and one-artifact integration are ready.
export function createWebWorkerComposition(deps?: WasmWorkerDeps) {
	const workerOwner = createWasmWorkerOwner(deps);
	return {
		workerOwner,
		crypto: createWasmWorkerCryptoPort(workerOwner.channel("crypto")),
	};
}

const composition = createWebWorkerComposition();
export const webWorkerOwner = composition.workerOwner;
export const crypto = composition.crypto;

// Spawning the worker and instantiating WASM costs the first sign-in about as much as the
// key derivation itself, so it is started at load. A failed load is not memoised, so the
// first real call still retries and reports.
if (typeof window !== "undefined") {
	void crypto.initialize().catch(() => undefined);
}
