/**
 * Crypto Adapter for Extension
 *
 * Wraps the WASM crypto functions to implement ICrypto interface
 * for use with shared auth utilities.
 */

import type { ICrypto } from "@bittery/types";
import {
	decrypt,
	deriveClientSession,
	deriveKeys,
	encrypt,
	generateClientEphemeralAsync,
	generateEncryptionKey,
	validateSecretKeyAsync,
	verifyServerSession,
} from "./wasm-crypto";

/**
 * ICrypto implementation using WASM crypto
 */
export const cryptoAdapter: ICrypto = {
	decrypt,
	encrypt,
	generateEncryptionKey,
	deriveKeys,
	generateClientEphemeral: generateClientEphemeralAsync,
	deriveClientSession,
	verifyServerSession,
	validateSecretKey: validateSecretKeyAsync,
};
