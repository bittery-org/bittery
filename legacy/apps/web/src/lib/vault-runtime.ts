import { createVaultRuntime } from "@bittery/core/services/vault-runtime";
import { crypto } from "./crypto";
import { itemCache, storage } from "./storage";

/** The browser context's shared local Vault projection. */
export const { vaultCrypto, vaultRepository } = createVaultRuntime({
	crypto,
	storage,
	itemCache,
});
