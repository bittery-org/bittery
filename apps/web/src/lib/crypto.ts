/**
 * The web app's crypto backend: one `CryptoPort` over one WASM worker.
 *
 * Built here rather than inside a component because `AccountStore` needs it before React
 * mounts, and because a second instance would mean a second key table — a `KeyRef` minted
 * by one port is rejected by the other.
 */

import { createWorkerRuntime } from "@bittery/client-runtime/worker-runtime";
import {
	createWasmWorkerCryptoPort,
	createWasmWorkerOwner,
	type WasmWorkerDeps,
} from "@bittery/crypto-port/adapters/wasm-worker";

// This process-wide owner is the single channel multiplexer for production Crypto and the cold
// Runtime transport. Product authentication/bootstrap remains outside this bounded batch.
export function createWebWorkerComposition(deps?: WasmWorkerDeps) {
	const workerOwner = createWasmWorkerOwner(
		deps ?? {
			createWorker: () =>
				new Worker(new URL("./runtime.worker.ts", import.meta.url), {
					type: "module",
				}),
		},
	);
	return {
		workerOwner,
		crypto: createWasmWorkerCryptoPort(workerOwner.channel("crypto")),
		runtime: createWorkerRuntime(
			workerOwner.channel("runtime"),
			workerOwner.close,
		),
	};
}

const composition = createWebWorkerComposition();
export const webWorkerOwner = composition.workerOwner;
export const crypto = composition.crypto;
/** Cold Runtime transport; product bootstrap remains deliberately unwired. */
export const runtime = composition.runtime;

// Spawning the worker and instantiating WASM costs the first sign-in about as much as the
// key derivation itself, so it is started at load. A failed load is not memoised, so the
// first real call still retries and reports.
if (typeof window !== "undefined") {
	void crypto.initialize().catch(() => undefined);
}
