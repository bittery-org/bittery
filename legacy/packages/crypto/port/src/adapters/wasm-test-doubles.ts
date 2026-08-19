/**
 * An in-process double for the one thing this adapter loads: `@bittery/crypto-wasm`.
 *
 * There is no worker here and nothing to fake for one — `createWasmCryptoPort` calls the
 * backend directly, so the only seam is `WasmCryptoPortDeps.loadBackend`.
 *
 * The double is shared with the worker adapter so both seams stay checked against the
 * generated binding-derived backend contract and use the same deterministic test cipher.
 *
 * Nothing here is exported to production code.
 */

import type { WasmCryptoPortDeps } from "./wasm";
import {
	type CryptoWasmDouble,
	createWasmWorkerDoubles,
} from "./wasm-worker-test-doubles";

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
	const shared = createWasmWorkerDoubles(options);
	const wasm = shared.wasm;
	let wasmLoads = 0;

	return {
		deps: {
			loadBackend: async () => {
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
