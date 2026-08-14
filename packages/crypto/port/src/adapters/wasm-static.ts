/**
 * The WASM port for callers that cannot reach the bindings through `import()`.
 *
 * The HTML specification bans dynamic import on `ServiceWorkerGlobalScope`, so the
 * browser extension's MV3 background cannot use `./wasm`'s default loader: the call
 * throws and every crypto operation in the worker fails with it. This entry is the one
 * place that names `@bittery/crypto-wasm` statically, which keeps the bundler's job a
 * plain static graph and leaves the binding boundary owned by this package.
 *
 * Instantiating the WASM binary is still lazy — that happens on the first port call.
 */

import * as wasm from "@bittery/crypto-wasm";
import type { CryptoPort } from "../crypto-port";
import { createWasmCryptoPortFromModule } from "./wasm";

export function createStaticWasmCryptoPort(): CryptoPort {
	return createWasmCryptoPortFromModule(wasm);
}
