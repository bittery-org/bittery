/**
 * One CryptoPort for the desktop renderer process.
 *
 * Storage, sync, and the UI must share this instance: a KeyRef belongs only to the adapter
 * closure that minted it.
 */

import { createTauriCryptoPort } from "@bittery/crypto-port/adapters/tauri";

export const crypto = createTauriCryptoPort();
