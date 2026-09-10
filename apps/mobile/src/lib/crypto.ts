import { createWasmWorkerCryptoPort } from "@bittery/crypto-port/adapters/wasm-worker";

export const crypto = createWasmWorkerCryptoPort();

// Preloading avoids delaying the first sign-in; failed initialization remains retryable.
if (typeof window !== "undefined") {
	void crypto.initialize().catch(() => undefined);
}
