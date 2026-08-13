import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import { createVaultRepository } from "@bittery/core/services/vault-repository";
import { crypto } from "./crypto";
import { itemCache, storage } from "./storage";

export const vaultCrypto = createVaultCrypto({ crypto, storage });

/** The browser context's shared local Vault projection. */
export const vaultRepository = createVaultRepository(
	crypto,
	vaultCrypto,
	storage,
	itemCache,
);

let vaultRuntime: AccountVaultRuntime | null = null;

const serverAccountSource: AccountVaultStateSource = {
	initializeLocalVaultState: async () => {},
	subscribe: () => () => {},
	getActiveAccount: () => null,
	getAccounts: () => [],
	getUnlockedAccountIds: () => [],
};

export function getWebVaultRuntime(
	manager: AccountVaultStateSource,
): AccountVaultRuntime {
	// TanStack Start must render the document (especially <Scripts />) on the
	// server, while browser storage must remain untouched there. This inert runtime
	// preserves the provider tree without creating a process-global SSR account scope.
	if (typeof window === "undefined") {
		return new AccountVaultRuntime(serverAccountSource, vaultRepository);
	}
	vaultRuntime ??= new AccountVaultRuntime(manager, vaultRepository);
	return vaultRuntime;
}

import {
	AccountVaultRuntime,
	type AccountVaultStateSource,
} from "@bittery/core/services/account-vault-runtime";
