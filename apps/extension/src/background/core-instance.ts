import { createCoreContext } from "@bittery/core";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "../lib/storage";

const vaultCrypto = createVaultCrypto({ crypto, storage });

export const core = createCoreContext({
	storage,
	itemCache,
	crypto,
	vaultCrypto,
});
