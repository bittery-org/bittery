import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { normalizeAccountServerUrl } from "@bittery/storage/account-id";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	DiscoveredItemEncryptionContext,
	ItemEncryptionContextMigrationPort,
	ItemSyncAcknowledgement,
	ItemSyncCommand,
} from "@bittery/types";
import type { AccountInfo } from "./account-resolver";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type { TravelModeApiClient } from "./travel-mode-service";
import type { VaultCrypto } from "./vault-crypto";
import {
	type VaultRepository,
	VaultRepository as VaultRepositoryImpl,
	type VaultRepositoryItem,
} from "./vault-repository";

export interface CoordinatedItemAccount {
	accountId: string;
	email: string;
	userId: string;
	name: string;
	serverUrl: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
}

export type CoordinatedItem = VaultRepositoryItem & {
	account?: CoordinatedItemAccount;
};

type RepoEntry = {
	repo: VaultRepository;
	unsubscribe: () => void;
};

export class VaultRepositoryCoordinator {
	private itemCommandExecutor?: (
		command: ItemSyncCommand,
	) => Promise<ItemSyncAcknowledgement | undefined>;
	private readonly repos = new Map<string, RepoEntry>();
	private readonly listeners = new Set<() => void>();
	private readonly accountInfoByAccountId = new Map<
		string,
		CoordinatedItemAccount
	>();
	private readonly apiClientByAccountId = new Map<
		string,
		AccountInfo["apiClient"]
	>();
	private readonly activeAccountIds = new Set<string>();
	private readonly hydratingAccountIds = new Set<string>();
	private readonly accountHydrations = new Map<string, Promise<void>>();
	private readonly serverRefreshes = new Map<
		string,
		Promise<{ id: string } | null>
	>();
	private readonly verifyingAccounts = new Map<string, Promise<void>>();
	private snapshot = 0;
	private encryptionContextMigrationPort?: ItemEncryptionContextMigrationPort;
	private readonly deferredEncryptionContextMigrations = new Map<
		string,
		DiscoveredItemEncryptionContext
	>();

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
				entry.repo.clear();
				continue;
			}
			if (entry.repo.isHydrated()) {
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
			entry.repo.hydrate().catch((error) => {
				console.error(
					`[VaultRepositoryCoordinator] hydrate after unlock failed for account ${accountId}:`,
					error,
				);
			});
		}
	}

	private emit(): void {
		this.snapshot++;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private attachRepo(accountId: string, repo: VaultRepository): void {
		const unsubscribe = repo.subscribe(() => {
			this.emit();
		});
		this.repos.set(accountId, { repo, unsubscribe });
	}

	private encryptionContextMigrationKey(
		context: DiscoveredItemEncryptionContext,
	): string {
		return `${context.accountId}:${context.itemId}`;
	}

	private async publishOrDeferEncryptionContextMigration(
		context: DiscoveredItemEncryptionContext,
	): Promise<void> {
		const port = this.encryptionContextMigrationPort;
		if (!port) {
			this.deferredEncryptionContextMigrations.set(
				this.encryptionContextMigrationKey(context),
				context,
			);
			return;
		}
		await port(context);
	}

	getOrCreate(
		accountId: string,
		serverUrl?: string,
		accountEmail?: string,
	): VaultRepository {
		const existing = this.repos.get(accountId);
		if (existing) {
			if (serverUrl) {
				existing.repo.setServerUrl(serverUrl);
			}
			return existing.repo;
		}

		const repo = new VaultRepositoryImpl(
			this.crypto,
			this.vaultCrypto,
			this.storage,
			this.itemCache,
			accountId,
			serverUrl,
			accountEmail,
			(context) => this.publishOrDeferEncryptionContextMigration(context),
			async (vaultId) => {
				const client = this.apiClientByAccountId.get(accountId);
				if (!client) return [];
				const { data: members } = await client.vaults.members.list(vaultId);
				return members.map((member) => member.userId);
			},
		);
		this.attachRepo(accountId, repo);
		return repo;
	}

	remove(accountId: string): void {
		const entry = this.repos.get(accountId);
		if (!entry) {
			return;
		}
		entry.unsubscribe();
		entry.repo.clear();
		this.repos.delete(accountId);
		this.accountInfoByAccountId.delete(accountId);
		this.apiClientByAccountId.delete(accountId);
		this.activeAccountIds.delete(accountId);
		for (const [key, context] of this.deferredEncryptionContextMigrations) {
			if (context.accountId === accountId) {
				this.deferredEncryptionContextMigrations.delete(key);
			}
		}
		this.emit();
	}

	private getActiveRepoEntries(): Array<[string, RepoEntry]> {
		if (this.activeAccountIds.size === 0) {
			return Array.from(this.repos.entries());
		}
		return Array.from(this.repos.entries()).filter(([accountId]) =>
			this.activeAccountIds.has(accountId),
		);
	}

	setActiveAccounts(accounts: AccountInfo[]): void {
		this.activeAccountIds.clear();
		this.accountInfoByAccountId.clear();
		this.apiClientByAccountId.clear();

		for (const account of accounts) {
			this.activeAccountIds.add(account.accountId);
			this.accountInfoByAccountId.set(account.accountId, {
				accountId: account.accountId,
				email: account.email,
				userId: account.userId,
				name: account.name,
				serverUrl: account.serverUrl,
				teamName: account.teamName,
				teamAvatarUrl: account.teamAvatarUrl,
			});
			this.apiClientByAccountId.set(account.accountId, account.apiClient);
			this.getOrCreate(account.accountId, account.serverUrl, account.email);
		}

		this.emit();
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
	): Promise<{ id: string } | null> {
		const existing = this.serverRefreshes.get(account.accountId);
		if (existing) {
			return existing;
		}

		const refresh = this.getOrCreate(
			account.accountId,
			account.serverUrl,
			account.email,
		)
			.hydrateFromServer(account.apiClient)
			.finally(() => {
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
				await repo.hydrate();
				if (!repo.hasCacheSnapshot()) {
					await this.refreshAccountFromServer(account);
				}
			} catch (error) {
				console.error(
					`[VaultRepositoryCoordinator] hydrate failed for account ${account.accountId}:`,
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

	async hydrate(accounts: AccountInfo[]): Promise<void> {
		this.setActiveAccounts(accounts);

		// Per-account failures are isolated: one account throwing (e.g. an
		// unverified travel-mode policy) must not abort hydration of the others.
		// A failed account simply yields no in-memory data (fail-closed).
		await Promise.all(accounts.map((account) => this.hydrateAccount(account)));
	}

	/**
	 * Hydrates the given accounts' repositories WITHOUT changing the active
	 * account set. Unlike `hydrate`, this never calls `setActiveAccounts`, so
	 * `getActiveRepoEntries` (and therefore the single-account item views) are
	 * left untouched. Used by the item Move dialog to make every unlocked
	 * account's vault keys available as cross-account move targets while a
	 * single account remains active.
	 */
	async hydrateAccountRepos(accounts: AccountInfo[]): Promise<void> {
		for (const account of accounts) {
			this.apiClientByAccountId.set(account.accountId, account.apiClient);
		}
		await Promise.all(accounts.map((account) => this.hydrateAccount(account)));
	}

	async initializeSyncBaseline(
		accounts: AccountInfo[],
		accountId: string,
		currentCursor: { id: string } | null = null,
	): Promise<{ id: string } | null> {
		this.setActiveAccounts(accounts);
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
		this.setActiveAccounts(accounts);
		await Promise.all(
			accounts.map(async (account) => {
				await this.accountHydrations.get(account.accountId);
				await this.refreshAccountFromServer(account);
			}),
		);
	}

	isHydrating(): boolean {
		return this.hydratingAccountIds.size > 0;
	}

	private withAccount(
		item: VaultRepositoryItem,
		accountId: string,
	): CoordinatedItem {
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

	getAll(): CoordinatedItem[] {
		const items: CoordinatedItem[] = [];
		for (const [accountId, entry] of this.getActiveRepoEntries()) {
			for (const item of this.filterItemsForAccount(
				accountId,
				entry.repo.getAll(),
			)) {
				items.push(this.withAccount(item, accountId));
			}
		}
		return items;
	}

	getByVault(vaultId: string): CoordinatedItem[] {
		const items: CoordinatedItem[] = [];
		for (const [accountId, entry] of this.getActiveRepoEntries()) {
			for (const item of this.filterItemsForAccount(
				accountId,
				entry.repo.getByVault(vaultId),
			)) {
				items.push(this.withAccount(item, accountId));
			}
		}
		return items;
	}

	getById(id: string): CoordinatedItem | undefined {
		for (const [accountId, entry] of this.getActiveRepoEntries()) {
			const item = entry.repo.getById(id);
			if (item) {
				const filtered = this.filterItemsForAccount(accountId, [item]);
				if (filtered.length === 0) {
					return undefined;
				}
				return this.withAccount(item, accountId);
			}
		}
		return undefined;
	}

	getDeleted(): CoordinatedItem[] {
		const items: CoordinatedItem[] = [];
		for (const [accountId, entry] of this.getActiveRepoEntries()) {
			for (const item of this.filterItemsForAccount(
				accountId,
				entry.repo.getDeleted(),
			)) {
				items.push(this.withAccount(item, accountId));
			}
		}
		return items;
	}

	findAccountForItem(
		itemId: string,
	): { accountId: string; repo: VaultRepository } | undefined {
		for (const [accountId, entry] of this.repos.entries()) {
			const item = entry.repo.getById(itemId);
			if (!item) {
				continue;
			}
			// The repo that actually held the item is authoritative. Prefer its
			// accountId directly; only fall back to legacy email canonicalization
			// when this account's info is unknown (so we never override a
			// known-correct accountId — which matters for two accounts sharing an
			// email across different servers).
			if (!this.accountInfoByAccountId.has(accountId) && item.accountEmail) {
				const accountInfo = Array.from(
					this.accountInfoByAccountId.values(),
				).find(
					(info) =>
						info.email.toLowerCase() === item.accountEmail?.toLowerCase(),
				);
				if (accountInfo) {
					return {
						accountId: accountInfo.accountId,
						repo: this.getOrCreate(accountInfo.accountId),
					};
				}
			}
			return { accountId, repo: entry.repo };
		}
		return undefined;
	}

	replaceItemId(tempId: string, realId: string, accountId: string): void {
		this.getOrCreate(accountId).replaceItemId(tempId, realId);
	}

	findAccountForVault(
		vaultId: string,
	): { accountId: string; repo: VaultRepository } | undefined {
		for (const [accountId, entry] of this.repos.entries()) {
			if (!entry.repo.hasVault(vaultId)) {
				continue;
			}
			const vault = entry.repo.getVaultById(vaultId);
			// The repo that actually held the vault is authoritative. Prefer its
			// accountId directly; only fall back to legacy email canonicalization
			// when this account's info is unknown, so a shared email across
			// servers can't redirect to the wrong account's repo.
			if (!this.accountInfoByAccountId.has(accountId) && vault?.accountEmail) {
				const accountInfo = Array.from(
					this.accountInfoByAccountId.values(),
				).find(
					(info) =>
						info.email.toLowerCase() === vault.accountEmail?.toLowerCase(),
				);
				if (accountInfo) {
					return {
						accountId: accountInfo.accountId,
						repo: this.getOrCreate(accountInfo.accountId),
					};
				}
			}
			return { accountId, repo: entry.repo };
		}
		return undefined;
	}

	private findAccountIdByEmail(email: string): string | undefined {
		const normalized = email.toLowerCase();
		for (const info of this.accountInfoByAccountId.values()) {
			if (info.email.toLowerCase() === normalized) {
				return info.accountId;
			}
		}
		return undefined;
	}

	resolveAccountIdByEmail(email: string): string | undefined {
		return this.findAccountIdByEmail(email);
	}

	getRepositoryForAccount(accountId: string): VaultRepository {
		return this.getOrCreate(accountId);
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
		this.accountHydrations.clear();
		this.serverRefreshes.clear();
		this.activeAccountIds.clear();
		this.accountInfoByAccountId.clear();
		this.apiClientByAccountId.clear();
		this.deferredEncryptionContextMigrations.clear();
		for (const entry of this.repos.values()) {
			entry.unsubscribe();
			entry.repo.clear();
		}
		this.repos.clear();
		this.emit();
	}

	// --- SyncItemCache surface (packages/sync/src/types.ts) ---
	async setEncryptionContextMigrationPort(
		port: ItemEncryptionContextMigrationPort | undefined,
	): Promise<void> {
		this.encryptionContextMigrationPort = port;
		if (!port) return;
		for (const [key, context] of this.deferredEncryptionContextMigrations) {
			await port(context);
			this.deferredEncryptionContextMigrations.delete(key);
		}
	}

	async publishPendingEncryptionContextMigration(
		accountId: string,
		itemId: string,
	): Promise<void> {
		await this.getOrCreate(accountId).publishPendingEncryptionContextMigration(
			itemId,
		);
	}

	async applyItemCommand(command: ItemSyncCommand): Promise<void> {
		await this.getOrCreate(command.accountId).applyItemCommand(command);
	}

	setItemCommandExecutor(
		executor: (
			command: ItemSyncCommand,
		) => Promise<ItemSyncAcknowledgement | undefined>,
	): void {
		this.itemCommandExecutor = executor;
	}

	async executeSemanticItemCommand(
		command: ItemSyncCommand,
	): Promise<ItemSyncAcknowledgement | undefined> {
		return this.itemCommandExecutor?.(command);
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
		entry?.repo.purgeHiddenVaults(hiddenVaultIds);
		this.emit();
	}
}

const coordinatorRegistry = new WeakMap<
	AccountStore,
	VaultRepositoryCoordinator
>();

export function getOrCreateVaultRepositoryCoordinator(
	crypto: CryptoPort,
	vaultCrypto: VaultCrypto,
	storage: AccountStore,
	itemCache: ItemCache,
): VaultRepositoryCoordinator {
	const existing = coordinatorRegistry.get(storage);
	if (existing) {
		return existing;
	}
	const created = new VaultRepositoryCoordinator(
		crypto,
		vaultCrypto,
		storage,
		itemCache,
	);
	coordinatorRegistry.set(storage, created);
	return created;
}
