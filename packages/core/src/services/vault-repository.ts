import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { normalizeAccountServerUrl } from "@bittery/storage/account-id";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemSyncAcknowledgement,
	ItemSyncCommand,
} from "@bittery/types";
import type { AccountInfo } from "./account-resolver";
import {
	type AccountVaultReplica,
	AccountVaultReplica as AccountVaultReplicaImpl,
	type VaultRepositoryItem,
} from "./account-vault-replica";

export type { VaultRepositoryItem } from "./account-vault-replica";

import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type { TravelModeApiClient } from "./travel-mode-service";
import type { VaultCrypto } from "./vault-crypto";

/** Local account identity. Deliberately carries no token or HTTP client. */
export interface LocalVaultAccount {
	accountId: string;
	email: string;
	userId: string;
	name: string;
	serverUrl: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
}

/**
 * The account an item is attributed to. Structurally identical to
 * {@link LocalVaultAccount} and kept as an alias so call sites still read in the
 * vocabulary of their own layer.
 */
export type VaultRepositoryItemAccount = LocalVaultAccount;

export type VaultRepositoryItemWithAccount = VaultRepositoryItem & {
	account?: VaultRepositoryItemAccount;
};

type RepoEntry = {
	replica: AccountVaultReplica;
	unsubscribe: () => void;
};

export class VaultRepository {
	private readonly repos = new Map<string, RepoEntry>();
	private readonly listeners = new Set<() => void>();
	private readonly accountInfoByAccountId = new Map<
		string,
		VaultRepositoryItemAccount
	>();
	private readonly activeAccountIds = new Set<string>();
	private readonly hydratingAccountIds = new Set<string>();
	private readonly accountHydrations = new Map<string, Promise<void>>();
	private readonly localOpenings = new Map<string, Promise<void>>();
	private readonly serverRefreshes = new Map<
		string,
		Promise<{ id: string } | null>
	>();
	private readonly queuedServerRefreshes = new Map<
		string,
		Promise<{ id: string } | null>
	>();
	private readonly hydrationTails = new Map<string, Promise<void>>();
	private readonly verifyingAccounts = new Map<string, Promise<void>>();
	private snapshot = 0;

	constructor(
		private readonly crypto: CryptoPort,
		private readonly vaultCrypto: VaultCrypto,
		private readonly storage: AccountStore,
		private readonly itemCache: ItemCache,
	) {
		// Lock state belongs to the store, not to whichever screen happened to trigger it:
		// a lock from settings, from auto-lock or from another window all have to drop the
		// decrypted items, and the unlock after it has to bring them back without waiting
		// for a screen to remount.
		storage.onUnlockStateChanged((unlockedAccountIds) => {
			this.applyUnlockState(unlockedAccountIds);
		});
	}

	/**
	 * Dropping is synchronous: no plaintext may outlive the lock by even a microtask.
	 * Restoring is not — it reads the cache — so it runs detached.
	 */
	private applyUnlockState(unlockedAccountIds: string[]): void {
		const unlocked = new Set(unlockedAccountIds);
		for (const [accountId, entry] of this.repos) {
			if (!unlocked.has(accountId)) {
				entry.replica.clear();
				continue;
			}
			if (entry.replica.isHydrated()) {
				continue;
			}
			// Travel mode is verified by the unlock flow itself, and some flows only get
			// there after the key is cached. Hydrating an unverified account would fail
			// closed, so that case is left to the hydrate the next mount runs.
			if (
				!getTravelModeEnforcer(this.storage, this.itemCache).isVerified(
					accountId,
				)
			) {
				continue;
			}
			this.runHydration(accountId, () => entry.replica.hydrate()).catch(
				(error) => {
					console.error(
						`[VaultRepository] hydrate after unlock failed for account ${accountId}:`,
						error,
					);
				},
			);
		}
	}

	/**
	 * Local cache opening and authoritative bootstrap both replace one replica's
	 * projection. Serializing them prevents a late local read from invalidating a
	 * just-committed server generation (or vice versa).
	 */
	private runHydration<T>(
		accountId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = this.hydrationTails.get(accountId) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.hydrationTails.set(accountId, tail);
		void tail.finally(() => {
			if (this.hydrationTails.get(accountId) === tail) {
				this.hydrationTails.delete(accountId);
			}
		});
		return result;
	}

	private emit(): void {
		this.snapshot++;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private attachReplica(accountId: string, replica: AccountVaultReplica): void {
		const unsubscribe = replica.subscribe(() => {
			this.emit();
		});
		this.repos.set(accountId, { replica, unsubscribe });
	}

	private getOrCreate(
		accountId: string,
		serverUrl?: string,
		accountEmail?: string,
	): AccountVaultReplica {
		const existing = this.repos.get(accountId);
		if (existing) {
			if (serverUrl) {
				existing.replica.setServerUrl(serverUrl);
			}
			return existing.replica;
		}

		const replica = new AccountVaultReplicaImpl(
			this.crypto,
			this.vaultCrypto,
			this.storage,
			this.itemCache,
			accountId,
			serverUrl,
			accountEmail,
		);
		this.attachReplica(accountId, replica);
		return replica;
	}

	remove(accountId: string): void {
		const entry = this.repos.get(accountId);
		if (!entry) {
			return;
		}
		entry.unsubscribe();
		entry.replica.clear();
		this.repos.delete(accountId);
		this.accountInfoByAccountId.delete(accountId);
		this.activeAccountIds.delete(accountId);
		this.emit();
	}

	private getActiveRepoEntries(): Array<[string, RepoEntry]> {
		return Array.from(this.repos.entries()).filter(([accountId]) =>
			this.activeAccountIds.has(accountId),
		);
	}

	private getReadEntries(accountId?: string): Array<[string, RepoEntry]> {
		if (accountId) {
			const entry = this.repos.get(accountId);
			return entry ? [[accountId, entry]] : [];
		}
		return this.getActiveRepoEntries();
	}

	setLocalActiveAccounts(accounts: LocalVaultAccount[]): void {
		this.activeAccountIds.clear();

		for (const account of accounts) {
			this.activeAccountIds.add(account.accountId);
			this.rememberLocalAccount(account);
		}

		this.emit();
	}

	private rememberAccount(account: AccountInfo): void {
		this.rememberLocalAccount(account);
	}

	private rememberLocalAccount(account: LocalVaultAccount): void {
		this.accountInfoByAccountId.set(account.accountId, {
			accountId: account.accountId,
			email: account.email,
			userId: account.userId,
			name: account.name,
			serverUrl: account.serverUrl,
			teamName: account.teamName,
			teamAvatarUrl: account.teamAvatarUrl,
		});
		this.getOrCreate(account.accountId, account.serverUrl, account.email);
	}

	/**
	 * Reconciles the local read scope and opens unlocked accounts exclusively from
	 * durable storage. Network capability is intentionally absent from this seam.
	 */
	async hydrateLocalAccounts(
		unlockedAccounts: LocalVaultAccount[],
	): Promise<void> {
		await Promise.all(
			unlockedAccounts.map((account) => {
				const existing = this.localOpenings.get(account.accountId);
				if (existing) return existing;
				const opening = this.runHydration(account.accountId, async () => {
					this.rememberLocalAccount(account);
					const replica = this.getOrCreate(
						account.accountId,
						account.serverUrl,
						account.email,
					);
					try {
						const enforcer = getTravelModeEnforcer(
							this.storage,
							this.itemCache,
							this,
						);
						if (!enforcer.isVerified(account.accountId)) {
							await enforcer.hydrateFromStorage(account.accountId);
						}
						await replica.hydrate();
					} catch (error) {
						// A failed re-open must never leave a prior decrypted generation visible.
						replica.clear();
						throw error;
					}
				});
				this.localOpenings.set(account.accountId, opening);
				return opening.finally(() => {
					if (this.localOpenings.get(account.accountId) === opening) {
						this.localOpenings.delete(account.accountId);
					}
				});
			}),
		);
	}

	/**
	 * Travel mode verification lives in memory, so it is lost on every page
	 * reload even though the unlocked session survives in storage. Platforms
	 * that re-run an unlock flow (desktop, mobile, extension) re-verify there;
	 * the web app boots straight into an unlocked vault and has no such hook.
	 * Verifying here covers both: it is a no-op once the account is verified,
	 * and it re-fetches the authoritative policy from the server otherwise, so
	 * a stale local cache can never fail open.
	 */
	private async ensureTravelModeVerified(account: AccountInfo): Promise<void> {
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache, this);
		if (enforcer.isVerified(account.accountId)) {
			return;
		}

		const inFlight = this.verifyingAccounts.get(account.accountId);
		if (inFlight) {
			return inFlight;
		}

		const verification = enforcer
			.verifyForUnlock(
				account.accountId,
				account.apiClient as unknown as TravelModeApiClient,
			)
			.then(() => undefined)
			.finally(() => {
				this.verifyingAccounts.delete(account.accountId);
			});
		this.verifyingAccounts.set(account.accountId, verification);
		return verification;
	}

	private refreshAccountFromServer(
		account: AccountInfo,
		afterInFlight = false,
	): Promise<{ id: string } | null> {
		const existing = this.serverRefreshes.get(account.accountId);
		if (existing) {
			if (!afterInFlight) return existing;
			const queued = this.queuedServerRefreshes.get(account.accountId);
			if (queued) return queued;
			const followUp = existing
				.catch(() => null)
				.then(() => {
					this.queuedServerRefreshes.delete(account.accountId);
					return this.refreshAccountFromServer(account, true);
				});
			this.queuedServerRefreshes.set(account.accountId, followUp);
			return followUp;
		}

		const replica = this.getOrCreate(
			account.accountId,
			account.serverUrl,
			account.email,
		);
		const refresh = this.runHydration(account.accountId, () =>
			replica.hydrateFromServer(account.apiClient),
		).finally(() => {
			this.serverRefreshes.delete(account.accountId);
		});
		this.serverRefreshes.set(account.accountId, refresh);
		return refresh;
	}

	private hydrateAccount(account: AccountInfo): Promise<void> {
		const existing = this.accountHydrations.get(account.accountId);
		if (existing) {
			return existing;
		}

		const hydration = (async () => {
			const repo = this.getOrCreate(
				account.accountId,
				account.serverUrl,
				account.email,
			);
			if (repo.isHydrated() && repo.hasCacheSnapshot()) {
				return;
			}

			this.hydratingAccountIds.add(account.accountId);
			this.emit();
			try {
				await this.ensureTravelModeVerified(account);
				await this.runHydration(account.accountId, () => repo.hydrate());
				if (!repo.hasCacheSnapshot()) {
					try {
						await this.refreshAccountFromServer(account);
					} catch {
						await this.refreshAccountFromServer(account);
					}
				}
			} catch (error) {
				console.error(
					`[VaultRepository] hydrate failed for account ${account.accountId}:`,
					error,
				);
			} finally {
				this.hydratingAccountIds.delete(account.accountId);
				this.emit();
			}
		})();
		this.accountHydrations.set(account.accountId, hydration);
		void hydration.finally(() => {
			this.accountHydrations.delete(account.accountId);
		});
		return hydration;
	}

	/** Remote enrichment without changing the runtime-owned local read scope. */
	async hydrateRemoteAccounts(accounts: AccountInfo[]): Promise<void> {
		for (const account of accounts) {
			this.rememberAccount(account);
		}
		// Per-account failures are isolated: one unavailable policy cannot abort
		// opening the remaining accounts; the failed account stays empty.
		await Promise.all(accounts.map((account) => this.hydrateAccount(account)));
	}

	async initializeSyncBaseline(
		accounts: AccountInfo[],
		accountId: string,
		currentCursor: { id: string } | null = null,
	): Promise<{ id: string } | null> {
		const account = accounts.find(
			(candidate) => candidate.accountId === accountId,
		);
		if (!account) {
			throw new Error(
				`Cannot initialize sync for unavailable account ${accountId}`,
			);
		}

		const serverUrl = normalizeAccountServerUrl(account.serverUrl);
		const metadataBeforeHydration =
			await this.itemCache.getItemCacheMetadata(accountId);
		const hadCommittedGeneration =
			metadataBeforeHydration?.syncBaseline?.serverUrl === serverUrl;
		await this.ensureTravelModeVerified(account);
		await this.hydrateAccount(account);
		const metadata = await this.itemCache.getItemCacheMetadata(accountId);
		if (metadata?.syncBaseline?.serverUrl === serverUrl) {
			if (hadCommittedGeneration && currentCursor) {
				return currentCursor;
			}
			return metadata.syncBaseline.cursorId
				? { id: metadata.syncBaseline.cursorId }
				: null;
		}

		await this.refreshAccountFromServer(account);
		const committedMetadata =
			await this.itemCache.getItemCacheMetadata(accountId);
		if (committedMetadata?.syncBaseline?.serverUrl !== serverUrl) {
			throw new Error(
				`Bootstrap for account ${accountId} did not commit a sync baseline`,
			);
		}

		return committedMetadata.syncBaseline.cursorId
			? { id: committedMetadata.syncBaseline.cursorId }
			: null;
	}

	async refreshFromServer(accounts: AccountInfo[]): Promise<void> {
		await Promise.all(
			accounts.map(async (account) => {
				await this.accountHydrations.get(account.accountId);
				// A caller asking for authoritative state must not join a bootstrap that
				// may have started before its triggering server commit. Queue one full pass
				// behind it; refreshes arriving after this call coalesce into that pass.
				await this.refreshAccountFromServer(account, true);
			}),
		);
	}

	isHydrating(): boolean {
		return this.hydratingAccountIds.size > 0;
	}

	private withAccount(
		item: VaultRepositoryItem,
		accountId: string,
	): VaultRepositoryItemWithAccount {
		const account = this.accountInfoByAccountId.get(accountId);
		if (!account) {
			return item;
		}
		return {
			...item,
			account,
		};
	}

	private filterItemsForAccount(
		accountId: string,
		items: VaultRepositoryItem[],
	): VaultRepositoryItem[] {
		return getTravelModeEnforcer(
			this.storage,
			this.itemCache,
			this,
		).filterItems(accountId, items);
	}

	getAll(accountId?: string): VaultRepositoryItemWithAccount[] {
		const items: VaultRepositoryItemWithAccount[] = [];
		for (const [entryAccountId, entry] of this.getReadEntries(accountId)) {
			for (const item of this.filterItemsForAccount(
				entryAccountId,
				entry.replica.getAll(),
			)) {
				items.push(this.withAccount(item, entryAccountId));
			}
		}
		return items;
	}

	getByVault(
		vaultId: string,
		accountId?: string,
	): VaultRepositoryItemWithAccount[] {
		const items: VaultRepositoryItemWithAccount[] = [];
		for (const [entryAccountId, entry] of this.getReadEntries(accountId)) {
			for (const item of this.filterItemsForAccount(
				entryAccountId,
				entry.replica.getByVault(vaultId),
			)) {
				items.push(this.withAccount(item, entryAccountId));
			}
		}
		return items;
	}

	getById(
		id: string,
		accountId?: string,
	): VaultRepositoryItemWithAccount | undefined {
		for (const [entryAccountId, entry] of this.getReadEntries(accountId)) {
			const item = entry.replica.getById(id);
			if (item) {
				const filtered = this.filterItemsForAccount(entryAccountId, [item]);
				if (filtered.length === 0) {
					return undefined;
				}
				return this.withAccount(item, entryAccountId);
			}
		}
		return undefined;
	}

	getDeleted(accountId?: string): VaultRepositoryItemWithAccount[] {
		const items: VaultRepositoryItemWithAccount[] = [];
		for (const [entryAccountId, entry] of this.getReadEntries(accountId)) {
			for (const item of this.filterItemsForAccount(
				entryAccountId,
				entry.replica.getDeleted(),
			)) {
				items.push(this.withAccount(item, entryAccountId));
			}
		}
		return items;
	}

	findAccountForItem(itemId: string): { accountId: string } | undefined {
		for (const [accountId, entry] of this.repos.entries()) {
			const item =
				entry.replica.getById(itemId) ??
				entry.replica.getDeleted().find((candidate) => candidate.id === itemId);
			if (!item) {
				continue;
			}
			return { accountId };
		}
		return undefined;
	}

	replaceItemId(tempId: string, realId: string, accountId: string): void {
		this.getOrCreate(accountId).replaceItemId(tempId, realId);
	}

	findAccountForVault(vaultId: string): { accountId: string } | undefined {
		for (const [accountId, entry] of this.repos.entries()) {
			if (!entry.replica.hasVault(vaultId)) {
				continue;
			}
			return { accountId };
		}
		return undefined;
	}

	getAccountInfo(accountId: string): VaultRepositoryItemAccount | undefined {
		const account = this.accountInfoByAccountId.get(accountId);
		return account ? { ...account } : undefined;
	}

	getVaultKeys(accountId: string): VaultKeyData[] {
		return this.getOrCreate(accountId).getVaultKeys();
	}

	isAccountHydrated(accountId: string): boolean {
		return this.repos.get(accountId)?.replica.isHydrated() ?? false;
	}

	getVaultById(
		vaultId: string,
		accountId: string,
	): CachedVaultMetadata | undefined {
		return this.getOrCreate(accountId).getVaultById(vaultId);
	}

	async upsertLocal(
		accountId: string,
		...args: Parameters<AccountVaultReplica["upsertLocal"]>
	): Promise<void> {
		await this.getOrCreate(accountId).upsertLocal(...args);
	}

	async encryptForVault(input: {
		accountId: string;
		vaultId: string;
		data: Parameters<AccountVaultReplica["encryptWithVaultKey"]>[1];
		itemId: string;
		version: number;
		userId?: string;
	}): ReturnType<AccountVaultReplica["encryptWithVaultKey"]> {
		return this.getOrCreate(input.accountId).encryptWithVaultKey(
			input.vaultId,
			input.data,
			{
				itemId: input.itemId,
				version: input.version,
				userId: input.userId,
			},
		);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): number => this.snapshot;

	clear(): void {
		this.hydratingAccountIds.clear();
		this.hydrationTails.clear();
		this.accountHydrations.clear();
		this.localOpenings.clear();
		this.serverRefreshes.clear();
		this.queuedServerRefreshes.clear();
		this.activeAccountIds.clear();
		this.accountInfoByAccountId.clear();
		for (const entry of this.repos.values()) {
			entry.unsubscribe();
			entry.replica.clear();
		}
		this.repos.clear();
		this.emit();
	}

	// --- Narrow Sync replica and command-projection ports ---
	async applyItemCommand(command: ItemSyncCommand): Promise<void> {
		await this.getOrCreate(command.accountId).applyItemCommand(command);
	}

	async discardItemCommandAcknowledgedElsewhere(
		command: ItemSyncCommand,
	): Promise<void> {
		await this.getOrCreate(
			command.accountId,
		).discardItemCommandAcknowledgedElsewhere(command);
	}

	async preserveItemConflict(
		command: ItemSyncCommand,
	): Promise<ItemSyncCommand | undefined> {
		return this.getOrCreate(command.accountId).preserveItemConflict(command);
	}

	async acknowledgeItemCommand(
		command: ItemSyncCommand,
		acknowledgement: ItemSyncAcknowledgement,
	): Promise<void> {
		await this.getOrCreate(command.accountId).acknowledgeItemCommand(
			command,
			acknowledgement,
		);
	}

	async reconcileAuthoritative(
		command: ItemSyncCommand,
		item: CachedEncryptedItem,
	): Promise<void> {
		await this.getOrCreate(command.accountId).upsertCachedItem(
			item,
			command.accountId,
		);
	}

	async upsertCachedItem(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		await this.getOrCreate(accountId).upsertEncrypted(item, accountId);
	}

	async removeCachedItem(itemId: string, accountId: string): Promise<void> {
		await this.getOrCreate(accountId).removeCachedItem(itemId, accountId);
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		accountId: string,
	): Promise<void> {
		await this.getOrCreate(accountId).upsertCachedVault(vault, accountId);
	}

	async removeCachedVault(vaultId: string, accountId: string): Promise<void> {
		await this.getOrCreate(accountId).removeCachedVault(vaultId, accountId);
	}

	async syncVaultKeys(
		vaultKeys: VaultKeyData[],
		accountId: string,
	): Promise<void> {
		await this.getOrCreate(accountId).syncVaultKeys(vaultKeys, accountId);
	}

	async clearItemCache(accountId: string): Promise<void> {
		await this.getOrCreate(accountId).clearItemCache(accountId);
	}

	purgeHiddenVaultsForAccount(
		accountId: string,
		hiddenVaultIds: string[],
	): void {
		const entry = this.repos.get(accountId);
		entry?.replica.purgeHiddenVaults(hiddenVaultIds);
		this.emit();
	}
}

export function createVaultRepository(
	crypto: CryptoPort,
	vaultCrypto: VaultCrypto,
	storage: AccountStore,
	itemCache: ItemCache,
): VaultRepository {
	return new VaultRepository(crypto, vaultCrypto, storage, itemCache);
}
