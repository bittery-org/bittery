import type { IStorageAdapter } from "@bittery/storage/adapter";
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
	accounts: AccountResolver;
	items: ItemService;
	vaults: VaultService;
	shares: ShareService;
	vaultCoordinator: VaultRepositoryCoordinator;
}

export interface CreateCoreContextOptions {
	storage: IStorageAdapter;
	crypto: ICrypto;
}

export function createCoreContext(
	options: CreateCoreContextOptions,
): CoreContext {
	const accounts = new AccountResolver(options.storage);
	const vaultCoordinator = getOrCreateVaultRepositoryCoordinator(
		options.crypto,
		options.storage,
	);
	const items = new ItemService({
		storage: options.storage,
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
		accounts,
		items,
		vaults,
		shares,
		vaultCoordinator,
	};
}
