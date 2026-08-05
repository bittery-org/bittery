/**
 * An in-process double for the one thing this adapter loads: `@bittery/crypto-wasm`.
 *
 * There is no worker here and nothing to fake for one — `createWasmCryptoPort` calls the
 * backend directly, so the only seam is `WasmCryptoPortDeps.loadCryptoWasm`.
 *
 * The double itself, `CryptoWasmDouble`, is **not** redefined in this file. It is imported
 * from `./wasm-worker-test-doubles`, where S5 built and fixed it: `CryptoWasmDouble
 * implements CryptoWasm`, so the compiler compares its signatures against
 * `bittery_crypto.d.ts` for both adapters at once, and its byte-expansion helper
 * (`expandBytes`) already carries the fix for the collision bug S5 found — putting the
 * index in front of the seed so 512 derivations produce 512 distinct keys rather than one
 * of 256. Reusing the class wholesale means this adapter inherits that fix and every other
 * property of the double for free, rather than risking a second, subtly different copy of
 * the same toy cipher and formats.
 *
 * Nothing here is exported to production code.
 */

import type { WasmCryptoPortDeps } from "./wasm";
import { CryptoWasmDouble } from "./wasm-worker-test-doubles";

export interface WasmDoublesOptions {
	/** Simulate a WASM module that will not instantiate. */
	wasmFailure?: unknown;
}

export interface WasmDoubles {
	/** Pass this to `createWasmCryptoPort`. */
	deps: WasmCryptoPortDeps;
	wasm: CryptoWasmDouble;
	/** How many times the backend loaded the WASM module. Should never exceed one. */
	readonly wasmLoads: number;
}

/** A fresh, empty double plus the `WasmCryptoPortDeps` that hand it out. */
export function createWasmDoubles(
	options: WasmDoublesOptions = {},
): WasmDoubles {
	const wasm = new CryptoWasmDouble();
	let wasmLoads = 0;

	return {
		deps: {
			loadCryptoWasm: async () => {
				wasmLoads += 1;
				if (options.wasmFailure !== undefined) {
					throw options.wasmFailure;
				}
				return wasm;
			},
		},
		wasm,
		get wasmLoads() {
			return wasmLoads;
		},
	};
}
