import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedEncryptedItem,
	CachedVaultMetadata,
	ICrypto,
} from "@bittery/types";
import type { AccountInfo } from "./account-resolver";
import {
	type BootstrapItemsClient,
	type VaultRepository,
	VaultRepository as VaultRepositoryImpl,
	type VaultRepositoryItem,
} from "./vault-repository";

export interface CoordinatedItemAccount {
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
	private readonly accountInfoByEmail = new Map<
		string,
		CoordinatedItemAccount
	>();
	private readonly activeEmails = new Set<string>();
	private readonly hydratingEmails = new Set<string>();
	private snapshot = 0;

	constructor(
		private readonly crypto: ICrypto,
		private readonly storage: IStorageAdapter,
	) {}

	private normalizeEmail(email: string): string {
		return email.toLowerCase();
	}

	private resolvePreferredEmail(email?: string): string | undefined {
		if (email) {
			const normalized = this.normalizeEmail(email);
			if (this.activeEmails.size === 0) {
				return normalized;
			}
			if (this.activeEmails.has(normalized)) {
				return normalized;
			}
			// If sync context points to a stale account while the UI has exactly one
			// active account, prefer the active account to keep cache updates visible.
			if (this.activeEmails.size === 1) {
				return Array.from(this.activeEmails)[0];
			}
			return normalized;
		}

		if (this.activeEmails.size === 1) {
			return Array.from(this.activeEmails)[0];
		}

		if (this.activeEmails.size === 0 && this.repos.size === 1) {
			return Array.from(this.repos.keys())[0];
		}

		return undefined;
	}

	private emit(): void {
		this.snapshot++;
		for (const listener of this.listeners) {
			listener();
		}
	}

	private attachRepo(email: string, repo: VaultRepository): void {
		const unsubscribe = repo.subscribe(() => {
			this.emit();
		});
		this.repos.set(email, { repo, unsubscribe });
	}

	getOrCreate(email: string, serverUrl?: string): VaultRepository {
		const normalized = this.normalizeEmail(email);
		const existing = this.repos.get(normalized);
		if (existing) {
			if (serverUrl) {
				existing.repo.setServerUrl(serverUrl);
			}
			return existing.repo;
		}

		const repo = new VaultRepositoryImpl(
			this.crypto,
			this.storage,
			normalized,
			serverUrl,
		);
		this.attachRepo(normalized, repo);
		return repo;
	}

	remove(email: string): void {
		const normalized = this.normalizeEmail(email);
		const entry = this.repos.get(normalized);
		if (!entry) {
			return;
		}
		entry.unsubscribe();
		entry.repo.clear();
		this.repos.delete(normalized);
		this.accountInfoByEmail.delete(normalized);
		this.activeEmails.delete(normalized);
		this.emit();
	}

	private getActiveRepoEntries(): Array<[string, RepoEntry]> {
		if (this.activeEmails.size === 0) {
			return Array.from(this.repos.entries());
		}
		return Array.from(this.repos.entries()).filter(([email]) =>
			this.activeEmails.has(email),
		);
	}

	setActiveAccounts(accounts: AccountInfo[]): void {
		this.activeEmails.clear();
		this.accountInfoByEmail.clear();

		for (const account of accounts) {
			const normalized = this.normalizeEmail(account.email);
			this.activeEmails.add(normalized);
			this.accountInfoByEmail.set(normalized, {
				email: normalized,
				userId: account.userId,
				name: account.name,
				serverUrl: account.serverUrl,
				teamName: account.teamName,
				teamAvatarUrl: account.teamAvatarUrl,
			});
			this.getOrCreate(normalized, account.serverUrl);
		}

		this.emit();
	}

	async hydrate(accounts: AccountInfo[]): Promise<void> {
		this.setActiveAccounts(accounts);

		await Promise.all(
			accounts.map(async (account) => {
				const normalized = this.normalizeEmail(account.email);
				const repo = this.getOrCreate(normalized, account.serverUrl);

				if (
					(repo.isHydrated() && repo.hasCacheSnapshot()) ||
					this.hydratingEmails.has(normalized)
				) {
					return;
				}

				this.hydratingEmails.add(normalized);
				this.emit();

				try {
					await repo.hydrate();

					// Bootstrap only when local cache has no established snapshot yet.
					if (!repo.hasCacheSnapshot()) {
						await repo.hydrateFromServer(
							account.trpcClient as unknown as BootstrapItemsClient,
						);
					}
				} finally {
					this.hydratingEmails.delete(normalized);
					this.emit();
				}
			}),
		);
	}

	async refreshFromServer(accounts: AccountInfo[]): Promise<void> {
		this.setActiveAccounts(accounts);
		await Promise.all(
			accounts.map(async (account) => {
				const normalized = this.normalizeEmail(account.email);
				const repo = this.getOrCreate(normalized, account.serverUrl);
				await repo.hydrateFromServer(
					account.trpcClient as unknown as BootstrapItemsClient,
				);
			}),
		);
	}

	isHydrating(): boolean {
		return this.hydratingEmails.size > 0;
	}

	private withAccount(
		item: VaultRepositoryItem,
		email: string,
	): CoordinatedItem {
		const account = this.accountInfoByEmail.get(email);
		if (!account) {
			return item;
		}
		return {
			...item,
			account,
		};
	}

	getAll(): CoordinatedItem[] {
		const items: CoordinatedItem[] = [];
		for (const [email, entry] of this.getActiveRepoEntries()) {
			for (const item of entry.repo.getAll()) {
				items.push(this.withAccount(item, email));
			}
		}
		return items;
	}

	getByVault(vaultId: string): CoordinatedItem[] {
		const items: CoordinatedItem[] = [];
		for (const [email, entry] of this.getActiveRepoEntries()) {
			for (const item of entry.repo.getByVault(vaultId)) {
				items.push(this.withAccount(item, email));
			}
		}
		return items;
	}

	getById(id: string): CoordinatedItem | undefined {
		for (const [email, entry] of this.getActiveRepoEntries()) {
			const item = entry.repo.getById(id);
			if (item) {
				return this.withAccount(item, email);
			}
		}
		return undefined;
	}

	getDeleted(): CoordinatedItem[] {
		const items: CoordinatedItem[] = [];
		for (const [email, entry] of this.getActiveRepoEntries()) {
			for (const item of entry.repo.getDeleted()) {
				items.push(this.withAccount(item, email));
			}
		}
		return items;
	}

	findAccountForItem(
		itemId: string,
	): { email: string; repo: VaultRepository } | undefined {
		for (const [email, entry] of this.repos.entries()) {
			const item = entry.repo.getById(itemId);
			if (!item) {
				continue;
			}
			if (item.accountEmail) {
				return {
					email: this.normalizeEmail(item.accountEmail),
					repo: this.getOrCreate(item.accountEmail),
				};
			}
			return { email, repo: entry.repo };
		}
		return undefined;
	}

	replaceItemId(tempId: string, realId: string, email?: string): void {
		if (email) {
			this.getOrCreate(email).replaceItemId(tempId, realId);
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
	): { email: string; repo: VaultRepository } | undefined {
		for (const [email, entry] of this.repos.entries()) {
			if (!entry.repo.hasVault(vaultId)) {
				continue;
			}
			const vault = entry.repo.getVaultById(vaultId);
			if (vault?.accountEmail) {
				return {
					email: this.normalizeEmail(vault.accountEmail),
					repo: this.getOrCreate(vault.accountEmail),
				};
			}
			return { email, repo: entry.repo };
		}
		return undefined;
	}

	getRepositoryForEmail(email: string): VaultRepository {
		return this.getOrCreate(email);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = (): number => this.snapshot;

	clear(): void {
		this.hydratingEmails.clear();
		this.activeEmails.clear();
		this.accountInfoByEmail.clear();
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
		email?: string,
	): Promise<void> {
		const targetEmail = this.resolvePreferredEmail(email);
		if (!targetEmail) {
			return;
		}
		const repo = this.getOrCreate(targetEmail);
		await repo.upsertEncrypted(item, targetEmail);
	}

	async upsertCachedItem(
		item: CachedEncryptedItem,
		email?: string,
	): Promise<void> {
		await this.upsertEncrypted(item, email);
	}

	async removeItem(itemId: string, email?: string): Promise<void> {
		if (email) {
			await this.getOrCreate(email).removeItem(itemId);
			return;
		}
		for (const entry of this.repos.values()) {
			if (entry.repo.getById(itemId)) {
				await entry.repo.removeItem(itemId);
				return;
			}
		}
	}

	async removeCachedItem(itemId: string, email?: string): Promise<void> {
		await this.removeItem(itemId, email);
	}

	async upsertVault(vault: CachedVaultMetadata, email?: string): Promise<void> {
		const targetEmail = this.resolvePreferredEmail(email);
		if (!targetEmail) {
			return;
		}
		await this.getOrCreate(targetEmail).upsertCachedVault(vault, targetEmail);
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		email?: string,
	): Promise<void> {
		await this.upsertVault(vault, email);
	}

	async removeVault(vaultId: string, email?: string): Promise<void> {
		if (email) {
			await this.getOrCreate(email).removeCachedVault(vaultId, email);
			return;
		}
		for (const entry of this.repos.values()) {
			if (entry.repo.hasVault(vaultId)) {
				await entry.repo.removeCachedVault(vaultId);
			}
		}
	}

	async removeCachedVault(vaultId: string, email?: string): Promise<void> {
		await this.removeVault(vaultId, email);
	}

	async syncVaultKeys(
		vaultKeys: VaultKeyData[],
		email?: string,
	): Promise<void> {
		const targetEmail = this.resolvePreferredEmail(email);
		if (!targetEmail) {
			return;
		}
		await this.getOrCreate(targetEmail).syncVaultKeys(vaultKeys, targetEmail);
	}

	async clearItemCache(email?: string): Promise<void> {
		if (email) {
			await this.getOrCreate(email).clearItemCache(email);
			return;
		}
		for (const [repoEmail, entry] of this.repos.entries()) {
			await entry.repo.clearItemCache(repoEmail);
		}
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
