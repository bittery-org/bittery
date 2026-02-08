import type { IStorageAdapter } from "@bittery/storage/adapter";
import { AccountResolver } from "./services/account-resolver";
import { CacheManager } from "./services/cache-manager";
import { ItemService } from "./services/item-service";
import { ShareService } from "./services/share-service";
import { VaultService } from "./services/vault-service";
import type { ICrypto } from "./types";

export interface CoreContext {
	accounts: AccountResolver;
	cache: CacheManager;
	items: ItemService;
	vaults: VaultService;
	shares: ShareService;
}

export interface CreateCoreContextOptions {
	storage: IStorageAdapter;
	crypto: ICrypto;
}

export function createCoreContext(
	options: CreateCoreContextOptions,
): CoreContext {
	const accounts = new AccountResolver(options.storage);
	const cache = new CacheManager(options.storage);
	const items = new ItemService({
		storage: options.storage,
		crypto: options.crypto,
		accounts,
		cache,
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
		accounts,
		cache,
		items,
		vaults,
		shares,
	};
}
