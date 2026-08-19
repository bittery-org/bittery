/**
 * The web app's crypto backend: one `CryptoPort` over one WASM worker.
 *
 * Built here rather than inside a component because `AccountStore` needs it before React
 * mounts, and because a second instance would mean a second key table — a `KeyRef` minted
 * by one port is rejected by the other.
 */

import { createWasmWorkerCryptoPort } from "@bittery/crypto-port/adapters/wasm-worker";

export const crypto = createWasmWorkerCryptoPort();

// Spawning the worker and instantiating WASM costs the first sign-in about as much as the
// key derivation itself, so it is started at load. A failed load is not memoised, so the
// first real call still retries and reports.
if (typeof window !== "undefined") {
	void crypto.initialize().catch(() => undefined);
}
