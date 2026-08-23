/**
 * The web app's Worker composition: one Worker, one `CryptoPort`, one Runtime.
 *
 * Built here rather than inside a component because `AccountStore` needs it before React
 * mounts, and because a second instance would mean a second key table — a `KeyRef` minted
 * by one port is rejected by the other.
 */

import { createWebClientRuntime } from "@bittery/client-runtime/web";
import { createWasmWorkerCryptoPort } from "@bittery/crypto-port/adapters/wasm-worker";

// The `new URL(..., import.meta.url)` literal has to sit inside `new Worker(...)` here: it
// resolves against this file, and it is the only form Vite recognises as a Worker entry.
const composition = createWebClientRuntime({
	createWorker: () =>
		new Worker(new URL("./runtime.worker.ts", import.meta.url), {
			type: "module",
		}),
});

export const webWorkerOwner = composition.workerOwner;
export const crypto = createWasmWorkerCryptoPort(composition.cryptoChannel);
/** Shared Worker Runtime. Web Items observation consumes `observe(Items)`. */
export const runtime = composition.runtime;

// Spawning the worker and instantiating WASM costs the first sign-in about as much as the
// key derivation itself, so it is started at load. A failed load is not memoised, so the
// first real call still retries and reports.
if (typeof window !== "undefined") {
	void crypto.initialize().catch(() => undefined);
}
