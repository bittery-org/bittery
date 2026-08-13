import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { resolveUserIdForScope } from "@bittery/storage/account-id";
import { AccountResolver } from "./services/account-resolver";
import type { AccountVaultRuntime } from "./services/account-vault-runtime";
import { type CommandQueuePort, ItemCommands } from "./services/item-commands";
import { ShareService } from "./services/share-service";
import type { VaultCrypto } from "./services/vault-crypto";
import type { VaultRepository } from "./services/vault-repository";
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
	itemCommands: ItemCommands;
	vaults: VaultService;
	shares: ShareService;
	vaultRepository: VaultRepository;
	vaultRuntime: AccountVaultRuntime;
	/** Explicit user-requested remote refresh; local reads never call this during render/bootstrap. */
	refreshActiveVaults(): Promise<void>;
}

export interface CreateCoreContextOptions {
	storage: AccountStore;
	itemCache: ItemCache;
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
	vaultRuntime: AccountVaultRuntime;
	commandQueue: CommandQueuePort;
	hydrateItem?: (accountId: string, itemId: string) => Promise<void>;
}

export function createCoreContext(
	options: CreateCoreContextOptions,
): CoreContext {
	const accounts = new AccountResolver(options.storage);
	const vaultRepository = options.vaultRuntime.repository;
	const itemCommands = new ItemCommands({
		queue: options.commandQueue,
		repository: vaultRepository,
		generateId: () => options.crypto.generateUuid(),
		now: Date.now,
		project: (command) => vaultRepository.applyItemCommand(command),
		hydrateItem: options.hydrateItem
			? async (account, itemId) =>
					options.hydrateItem?.(account.accountId, itemId)
			: undefined,
		resolveUserId: (accountId) =>
			resolveUserIdForScope(options.storage, accountId),
	});
	const vaults = new VaultService({
		storage: options.storage,
		crypto: options.crypto,
		vaultCrypto: options.vaultCrypto,
		accounts,
		vaultKeyProjection: vaultRepository,
	});
	const shares = new ShareService({
		storage: options.storage,
		crypto: options.crypto,
		vaultCrypto: options.vaultCrypto,
		accounts,
	});
	const refreshActiveVaults = async (): Promise<void> => {
		// First recover the local projection and clear any runtime hydration error.
		// The explicit remote refresh follows only once the local read seam is sound.
		await options.vaultRuntime.retry();
		const { activeAccount, accountsInfo } = await accounts.resolveAccounts();
		if (!activeAccount) return;
		if (accountsInfo.length === 0) {
			throw new Error(
				`No authenticated API client for account ${activeAccount}`,
			);
		}
		await vaultRepository.refreshFromServer(accountsInfo);
	};

	return {
		storage: options.storage,
		itemCache: options.itemCache,
		vaultCrypto: options.vaultCrypto,
		accounts,
		itemCommands,
		vaults,
		shares,
		vaultRepository,
		vaultRuntime: options.vaultRuntime,
		refreshActiveVaults,
	};
}
