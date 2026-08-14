import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { createVaultRepository } from "@bittery/core/services/vault-repository";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "./storage";

export const vaultCrypto = createVaultCrypto({ crypto, storage });

/** The native JavaScript context's shared local Vault projection. */
export const vaultRepository = createVaultRepository(
	crypto,
	vaultCrypto,
	storage,
	itemCache,
);
