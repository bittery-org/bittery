import type { AccountStore, ItemCache } from "@bittery/storage";
import type { ICrypto } from "@bittery/types";
import { AccountResolver } from "./services/account-resolver";
import { ItemService } from "./services/item-service";
import { ShareService } from "./services/share-service";
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
	accounts: AccountResolver;
	items: ItemService;
	vaults: VaultService;
	shares: ShareService;
	vaultCoordinator: VaultRepositoryCoordinator;
}

export interface CreateCoreContextOptions {
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: ICrypto;
}

export function createCoreContext(
	options: CreateCoreContextOptions,
): CoreContext {
	const accounts = new AccountResolver(options.storage);
	const vaultCoordinator = getOrCreateVaultRepositoryCoordinator(
		options.crypto,
		options.storage,
		options.itemCache,
	);
	const items = new ItemService({
		storage: options.storage,
		itemCache: options.itemCache,
		crypto: options.crypto,
		accounts,
	});
	const vaults = new VaultService({
		storage: options.storage,
		crypto: options.crypto,
		accounts,
	});
	const shares = new ShareService({
		storage: options.storage,
		crypto: options.crypto,
		accounts,
	});

	return {
		storage: options.storage,
		itemCache: options.itemCache,
		accounts,
		items,
		vaults,
		shares,
		vaultCoordinator,
	};
}
