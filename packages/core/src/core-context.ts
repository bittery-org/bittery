import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { AccountResolver } from "./services/account-resolver";
import { ItemService } from "./services/item-service";
import { ShareService } from "./services/share-service";
import type { VaultCrypto } from "./services/vault-crypto";
import {
	getOrCreateVaultRepositoryCoordinator,
	type VaultRepositoryCoordinator,
} from "./services/vault-repository-coordinator";
import { VaultService } from "./services/vault-service";

export interface CoreContext {
	/** Account-scoped settings, secrets and session state. */
	storage: AccountStore;
	/**
	 * The encrypted item/vault cache. A **sibling** of `storage`, not something it
	 * wraps: `AccountStore` speaks `PlatformPort`, `ItemCache` speaks `RecordPort`, and
	 * neither can reach the other. Anything that has to clear both (sign-out, account
	 * removal, login onto a reused accountId) sequences them here, above the seam.
	 */
	itemCache: ItemCache;
	/** Every account, vault and item key ceremony, over the platform's `CryptoPort`. */
	vaultCrypto: VaultCrypto;
	accounts: AccountResolver;
	items: ItemService;
	vaults: VaultService;
	shares: ShareService;
	vaultCoordinator: VaultRepositoryCoordinator;
}

export interface CreateCoreContextOptions {
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
}

export function createCoreContext(
	options: CreateCoreContextOptions,
): CoreContext {
	const accounts = new AccountResolver(options.storage);
	const vaultCoordinator = getOrCreateVaultRepositoryCoordinator(
		options.crypto,
		options.vaultCrypto,
		options.storage,
		options.itemCache,
	);
	const items = new ItemService({
		storage: options.storage,
		itemCache: options.itemCache,
		crypto: options.crypto,
		vaultCrypto: options.vaultCrypto,
		accounts,
	});
	const vaults = new VaultService({
		storage: options.storage,
		crypto: options.crypto,
		vaultCrypto: options.vaultCrypto,
		accounts,
	});
	const shares = new ShareService({
		storage: options.storage,
		crypto: options.crypto,
		vaultCrypto: options.vaultCrypto,
		accounts,
	});

	return {
		storage: options.storage,
		itemCache: options.itemCache,
		vaultCrypto: options.vaultCrypto,
		accounts,
		items,
		vaults,
		shares,
		vaultCoordinator,
	};
}
