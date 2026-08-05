/**
 * One CryptoPort for this React Native JavaScript process.
 *
 * AccountStore, sync, and the UI must share this closure because a KeyRef belongs only to
 * the port that minted it.
 */

import { createExpoCryptoPort } from "@bittery/crypto-port/adapters/expo";

export const crypto = createExpoCryptoPort();
