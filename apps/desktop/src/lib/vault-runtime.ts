import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { createVaultRepository } from "@bittery/core/services/vault-repository";
import { crypto } from "./crypto";
import { itemCache, storage } from "./storage";

export const vaultCrypto = createVaultCrypto({ crypto, storage });

/** The renderer's shared local Vault projection. */
export const vaultRepository = createVaultRepository(
	crypto,
	vaultCrypto,
	storage,
	itemCache,
);
