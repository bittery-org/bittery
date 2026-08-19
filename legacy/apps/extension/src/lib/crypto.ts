/**
 * One CryptoPort per extension JavaScript process.
 *
 * AccountStore and background services must share this instance: a KeyRef is meaningful
 * only to the adapter closure that minted it. MV3 creates a fresh module graph after a
 * service-worker recycle, which intentionally creates a fresh port and key table.
 *
 * The static adapter, not the default one, because this module also loads in the
 * background service worker, where the HTML specification bans `import()` — the dynamic
 * default throws there and takes every crypto operation in the worker down with it.
 */

import { createStaticWasmCryptoPort } from "@bittery/crypto-port/adapters/wasm-static";

export const crypto = createStaticWasmCryptoPort();
