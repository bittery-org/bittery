/**
 * The local Vault projection for one JavaScript context.
 *
 * Every frontend built the same two objects in the same order from the same
 * three platform primitives — web, desktop, mobile and the extension each had a
 * near-identical `vault-runtime.ts`. What differs between them is only *which*
 * `CryptoPort` and `AccountStore` they pass, which is what this takes as
 * arguments.
 *
 * The order matters and is why this is a factory rather than a convention:
 * `vaultCrypto` is built first because the repository takes it, and both must be
 * the same instances the rest of the context uses — a `KeyRef` minted by one
 * `CryptoPort` is meaningless to another, so a second runtime would mean a second
 * key table.
 */

import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { createVaultCrypto, type VaultCrypto } from "./vault-crypto";
import {
	createVaultRepository,
	type VaultRepository,
} from "./vault-repository";

export interface VaultRuntimeDeps {
	crypto: CryptoPort;
	storage: AccountStore;
	itemCache: ItemCache;
}

export interface VaultRuntime {
	vaultCrypto: VaultCrypto;
	vaultRepository: VaultRepository;
}

export function createVaultRuntime(deps: VaultRuntimeDeps): VaultRuntime {
	const { crypto, storage, itemCache } = deps;
	const vaultCrypto = createVaultCrypto({ crypto, storage });

	return {
		vaultCrypto,
		vaultRepository: createVaultRepository(
			crypto,
			vaultCrypto,
			storage,
			itemCache,
		),
	};
}
