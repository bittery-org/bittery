import { createVaultRuntime } from "@bittery/core/services/vault-runtime";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "./storage";

/** The native JavaScript context's shared local Vault projection. */
export const { vaultCrypto, vaultRepository } = createVaultRuntime({
	crypto,
	storage,
	itemCache,
});
