import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ICrypto,
} from "@bittery/types";
import type { AccountInfo } from "./account-resolver";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type { TravelModeRpcClient } from "./travel-mode-service";
import {
	type BootstrapItemsClient,
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
	readonly supportsItemCache = true;

	private readonly repos = new Map<string, RepoEntry>();
	private readonly listeners = new Set<() => void>();
	private readonly accountInfoByAccountId = new Map<
		string,
		CoordinatedItemAccount
	>();
	private readonly activeAccountIds = new Set<string>();
	private readonly hydratingAccountIds = new Set<string>();
	private readonly verifyingAccounts = new Map<string, Promise<void>>();
	private snapshot = 0;

	constructor(
		private readonly crypto: ICrypto,
		private readonly storage: IStorageAdapter,
	) {}

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
			this.storage,
			accountId,
			serverUrl,
			accountEmail,
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
		this.activeAccountIds.delete(accountId);
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
		const enforcer = getTravelModeEnforcer(this.storage, this);
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
				account.rpcClient as unknown as TravelModeRpcClient,
			)
			.then(() => undefined)
			.finally(() => {
				this.verifyingAccounts.delete(account.accountId);
			});
		this.verifyingAccounts.set(account.accountId, verification);
		return verification;
	}

	async hydrate(accounts: AccountInfo[]): Promise<void> {
		this.setActiveAccounts(accounts);

		// Per-account failures are isolated: one account throwing (e.g. an
		// unverified travel-mode policy) must not abort hydration of the others.
		// A failed account simply yields no in-memory data (fail-closed).
		await Promise.all(
			accounts.map(async (account) => {
				const repo = this.getOrCreate(
					account.accountId,
					account.serverUrl,
					account.email,
				);

				if (
					(repo.isHydrated() && repo.hasCacheSnapshot()) ||
					this.hydratingAccountIds.has(account.accountId)
				) {
					return;
				}

				this.hydratingAccountIds.add(account.accountId);
				this.emit();

				try {
					await this.ensureTravelModeVerified(account);
					await repo.hydrate();

					// Bootstrap only when local cache has no established snapshot yet.
					if (!repo.hasCacheSnapshot()) {
						await repo.hydrateFromServer(
							account.rpcClient as unknown as BootstrapItemsClient,
						);
					}
				} catch (error) {
					// Log only the accountId, never the underlying data, so an
					// unverified/failed account cannot leak hidden-vault contents.
					console.error(
						`[VaultRepositoryCoordinator] hydrate failed for account ${account.accountId}:`,
						error,
					);
				} finally {
					this.hydratingAccountIds.delete(account.accountId);
					this.emit();
				}
			}),
		);
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
		await Promise.all(
			accounts.map(async (account) => {
				const repo = this.getOrCreate(
					account.accountId,
					account.serverUrl,
					account.email,
				);

				if (
					(repo.isHydrated() && repo.hasCacheSnapshot()) ||
					this.hydratingAccountIds.has(account.accountId)
				) {
					return;
				}

				this.hydratingAccountIds.add(account.accountId);
				this.emit();

				try {
					await this.ensureTravelModeVerified(account);
					await repo.hydrate();

					if (!repo.hasCacheSnapshot()) {
						await repo.hydrateFromServer(
							account.rpcClient as unknown as BootstrapItemsClient,
						);
					}
				} catch (error) {
					console.error(
						`[VaultRepositoryCoordinator] hydrateAccountRepos failed for account ${account.accountId}:`,
						error,
					);
				} finally {
					this.hydratingAccountIds.delete(account.accountId);
					this.emit();
				}
			}),
		);
	}

	async refreshFromServer(accounts: AccountInfo[]): Promise<void> {
		this.setActiveAccounts(accounts);
		await Promise.all(
			accounts.map(async (account) => {
				const repo = this.getOrCreate(
					account.accountId,
					account.serverUrl,
					account.email,
				);
				await repo.hydrateFromServer(
					account.rpcClient as unknown as BootstrapItemsClient,
				);
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
		return getTravelModeEnforcer(this.storage, this).filterItems(
			accountId,
			items,
		);
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

	replaceItemId(tempId: string, realId: string, accountId?: string): void {
		if (accountId) {
			this.getOrCreate(accountId).replaceItemId(tempId, realId);
			return;
		}

		const located = this.findAccountForItem(tempId);
		if (!located) {
			return;
		}
		located.repo.replaceItemId(tempId, realId);
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
		this.activeAccountIds.clear();
		this.accountInfoByAccountId.clear();
		for (const entry of this.repos.values()) {
			entry.unsubscribe();
			entry.repo.clear();
		}
		this.repos.clear();
		this.emit();
	}

	// ItemCacheAdapter compatibility for useSync delta updates.
	async upsertEncrypted(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		const repo = this.getOrCreate(accountId);
		await repo.upsertEncrypted(item, accountId);
	}

	async upsertCachedItem(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		await this.upsertEncrypted(item, accountId);
	}

	async removeItem(itemId: string, accountId?: string): Promise<void> {
		if (accountId) {
			await this.getOrCreate(accountId).removeItem(itemId);
			return;
		}
		for (const entry of this.repos.values()) {
			if (entry.repo.getById(itemId)) {
				await entry.repo.removeItem(itemId);
				return;
			}
		}
	}

	async removeCachedItem(itemId: string, accountId?: string): Promise<void> {
		await this.removeItem(itemId, accountId);
	}

	async upsertVault(
		vault: CachedVaultMetadata,
		accountId: string,
	): Promise<void> {
		await this.getOrCreate(accountId).upsertCachedVault(vault, accountId);
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		accountId: string,
	): Promise<void> {
		await this.upsertVault(vault, accountId);
	}

	async removeVault(vaultId: string, accountId?: string): Promise<void> {
		if (accountId) {
			await this.getOrCreate(accountId).removeCachedVault(vaultId, accountId);
			return;
		}
		for (const entry of this.repos.values()) {
			if (entry.repo.hasVault(vaultId)) {
				await entry.repo.removeCachedVault(vaultId);
			}
		}
	}

	async removeCachedVault(vaultId: string, accountId?: string): Promise<void> {
		await this.removeVault(vaultId, accountId);
	}

	async syncVaultKeys(
		vaultKeys: VaultKeyData[],
		accountId: string,
	): Promise<void> {
		await this.getOrCreate(accountId).syncVaultKeys(vaultKeys, accountId);
	}

	async clearItemCache(accountId?: string): Promise<void> {
		if (accountId) {
			await this.getOrCreate(accountId).clearItemCache(accountId);
			return;
		}
		for (const [repoAccountId, entry] of this.repos.entries()) {
			await entry.repo.clearItemCache(repoAccountId);
		}
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
	IStorageAdapter,
	VaultRepositoryCoordinator
>();

export function getOrCreateVaultRepositoryCoordinator(
	crypto: ICrypto,
	storage: IStorageAdapter,
): VaultRepositoryCoordinator {
	const existing = coordinatorRegistry.get(storage);
	if (existing) {
		return existing;
	}
	const created = new VaultRepositoryCoordinator(crypto, storage);
	coordinatorRegistry.set(storage, created);
	return created;
}
