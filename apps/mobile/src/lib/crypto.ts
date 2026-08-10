/**
 * One CryptoPort for this React Native JavaScript process.
 *
 * AccountStore, sync, and the UI must share this closure because a KeyRef belongs only to
 * the port that minted it.
 */

import { createReactNativeCryptoPort } from "@bittery/crypto-port/adapters/react-native";

export const crypto = createReactNativeCryptoPort();
