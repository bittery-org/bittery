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

let vaultRuntime: AccountVaultRuntime | null = null;

export function getDesktopVaultRuntime(
	manager: AccountVaultStateSource,
): AccountVaultRuntime {
	vaultRuntime ??= new AccountVaultRuntime(manager, vaultRepository);
	vaultRuntime.start();
	return vaultRuntime;
}

import {
	AccountVaultRuntime,
	type AccountVaultStateSource,
} from "@bittery/core/services/account-vault-runtime";
