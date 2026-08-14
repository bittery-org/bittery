import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { createVaultRepository } from "@bittery/core/services/vault-repository";
import { crypto } from "./crypto";
import { itemCache, storage } from "./storage";

/**
 * One local Vault projection per extension JavaScript context. The popup and
 * service worker are separate contexts by design; the worker remains the sole
 * owner of durable Sync while runtime messages reconcile the popup projection.
 */
export const vaultCrypto = createVaultCrypto({ crypto, storage });

export const vaultRepository = createVaultRepository(
	crypto,
	vaultCrypto,
	storage,
	itemCache,
);
