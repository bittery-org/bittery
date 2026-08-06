/**
 * One CryptoPort per extension JavaScript process.
 *
 * AccountStore and background services must share this instance: a KeyRef is meaningful
 * only to the adapter closure that minted it. MV3 creates a fresh module graph after a
 * service-worker recycle, which intentionally creates a fresh port and key table.
 */

import { createWasmCryptoPort } from "@bittery/crypto-port/adapters/wasm";

export const crypto = createWasmCryptoPort();
