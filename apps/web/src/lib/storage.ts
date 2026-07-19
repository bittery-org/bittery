/**
 * Web App Storage Module
 * Singleton instance of the WebStorageAdapter with injected crypto
 */

import { createWebStorageAdapter } from "@bittery/storage/adapters/web";
import type { KdfProfile } from "@bittery/types";
import {
	decrypt,
	decryptKeyHandleWithWrappingKey,
	decryptWithKeyHandle,
	destroyKeyHandle,
	encrypt,
	encryptKeyHandleWithWrappingKey,
	encryptWithKeyHandle,
	exportKeyHandle,
	rsaDecrypt,
} from "./wasm-crypto";

// Create crypto provider from WASM crypto wrapper
const cryptoProvider = {
	encrypt,
	decrypt,
	rsaDecrypt,
	encryptWithKeyHandle,
	decryptWithKeyHandle,
	encryptKeyHandleWithWrappingKey,
	decryptKeyHandleWithWrappingKey,
	exportKeyHandle,
	destroyKeyHandle,
};

// Singleton adapter instance
export const storage = createWebStorageAdapter(cryptoProvider);

/**
 * Resolves the KDF params pinned for the active account at login. Flows that
 * re-derive the *existing* account's keys (e.g. verifying the current password
 * before a change) must use these params rather than the current crypto-core
 * default, otherwise an account keyed at an older iteration count fails to
 * decrypt its own data (issue #32). Returns `undefined` when no pin exists so
 * callers fall back to the default.
 */
export async function getActiveAccountKdfProfile(): Promise<{
	accountId: string;
	profile: KdfProfile;
}> {
	const active = await storage.getActiveAccount();
	if (active?.type !== "single") {
		throw new Error("No active account");
	}
	const profile = await storage.getPinnedKdfProfile(active.accountId);
	if (!profile) {
		throw new Error("Pinned KDF profile missing; sign in again");
	}
	return { accountId: active.accountId, profile };
}

// Re-export types for convenience
export type {
	AccountMetadata,
	StoredSessionData,
	VaultKeyData,
} from "@bittery/storage";
