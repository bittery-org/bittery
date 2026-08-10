import type { CryptoPort, KeyRef } from "@bittery/crypto-port";
import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import {
	decodeVaultType,
	type ServerVaultListEntry,
	type ServerVaultSummary,
	toCachedVaultFields,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { resolveUserIdForAccount } from "@bittery/storage/account-id";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedVaultMetadata,
	EncryptedData,
} from "@bittery/types";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import { isVaultHidden } from "./travel-mode-service";
import type { VaultCrypto } from "./vault-crypto";

export interface VaultView {
	id: string;
	name: string;
	type: string;
	icon: string | null;
	imageUrl: string | null;
}

export interface VaultRepositoryItem extends DecryptedItem {
	accountId?: string;
	accountEmail?: string;
	serverUrl?: string;
	deletedAt: string | null;
	version: number;
	lastModifiedBy: string | null;
	attachments?: CachedAttachment[];
	_encrypted: {
		data: string;
		iv: string;
		algorithm: string;
	};
	vault: VaultView;
}

export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

interface BootstrapItemPage {
	items: Array<{
		id: string;
		vaultId: string;
		category: string;
		favorite: boolean;
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
		version?: number;
		lastModifiedBy?: string | null;
		createdAt: string | Date;
		updatedAt: string | Date;
		deletedAt?: string | Date | null;
		attachments?: CachedAttachment[];
		vault: ServerVaultSummary;
	}>;
	hasMore: boolean;
	nextCursor?: string;
}

export interface BootstrapItemsClient {
	sync: {
		bootstrapItems: {
			query: (input: {
				cursor?: string;
				limit?: number;
			}) => Promise<BootstrapItemPage>;
		};
	};
	vault?: {
		list?: {
			query: () => Promise<Array<ServerVaultListEntry>>;
		};
	};
}

export class VaultRepository {
	private readonly fallbackServerUrl = getDefaultServerUrl();

	private readonly items = new Map<string, VaultRepositoryItem>();
	private readonly vaults = new Map<string, CachedVaultMetadata>();
	private readonly vaultKeyEntries = new Map<string, VaultKeyData>();
	private readonly listeners = new Set<() => void>();
	private snapshot = 0;
	private hydrated = false;
	private hydrating = false;
	private hasCacheSnapshotFlag = false;
	private serverUrl?: string;

	/**
	 * One repo is bound to one account for its whole life: every cache read, write,
	 * RPC and crypto call below keys off this `accountId` rather than re-resolving.
	 */
	constructor(
		private readonly crypto: CryptoPort,
		private readonly vaultCrypto: VaultCrypto,
		private readonly storage: AccountStore,
		private readonly itemCache: ItemCache,
		private readonly accountId: string,
		serverUrl?: string,
		private readonly accountEmail?: string,
	) {
		this.serverUrl = serverUrl;
	}

	getAccountId(): string {
		return this.accountId;
	}

	getAccountEmail(): string | undefined {
		return this.accountEmail;
	}

	getServerUrl(): string | undefined {
		return this.serverUrl;
	}

	setServerUrl(serverUrl?: string): void {
		this.serverUrl = serverUrl ?? undefined;
	}

	isHydrated(): boolean {
		return this.hydrated;
	}

	/**
	 * Every item and vault key in here is decrypted under the account's master unlock key,
	 * so a locked account has nothing this repository can build. Callers hydrate on mount
	 * and on every account change, which is well before the user has unlocked.
	 */
	private async isLocked(): Promise<boolean> {
		return (await this.storage.getMasterUnlockKey(this.accountId)) === null;
	}

	isHydrating(): boolean {
		return this.hydrating;
	}

	hasCacheSnapshot(): boolean {
		return this.hasCacheSnapshotFlag;
	}

	getAll(): VaultRepositoryItem[] {
		const items = Array.from(this.items.values()).filter(
			(item) => !item.deletedAt,
		);
		return this.applyTravelModeItemFilter(items);
	}

	getByVault(vaultId: string): VaultRepositoryItem[] {
		if (this.isTravelModeVaultHidden(vaultId)) {
			return [];
		}
		return Array.from(this.items.values()).filter(
			(item) => item.vaultId === vaultId && !item.deletedAt,
		);
	}

	getById(id: string): VaultRepositoryItem | undefined {
		const item = this.items.get(id);
		if (!item || item.deletedAt) {
			return undefined;
		}
		if (this.isTravelModeVaultHidden(item.vaultId)) {
			return undefined;
		}
		return item;
	}

	getDeleted(): VaultRepositoryItem[] {
		const items = Array.from(this.items.values()).filter(
			(item) => !!item.deletedAt,
		);
		return this.applyTravelModeItemFilter(items);
	}

	getVaults(): CachedVaultMetadata[] {
		const vaults = Array.from(this.vaults.values());
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return [];
		const config = enforcer.getConfig(this.accountId);
		if (!config.enabled) {
			return vaults;
		}
		return vaults.filter((vault) => !isVaultHidden(config, vault.id));
	}

	getVaultById(vaultId: string): CachedVaultMetadata | undefined {
		if (this.isTravelModeVaultHidden(vaultId)) {
			return undefined;
		}
		return this.vaults.get(vaultId);
	}

	getVaultKeys(): VaultKeyData[] {
		const vaultKeys = Array.from(this.vaultKeyEntries.values());
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return [];
		return enforcer.filterVaultKeys(this.accountId, vaultKeys);
	}

	hasVault(vaultId: string): boolean {
		return this.vaults.has(vaultId);
	}

	getSnapshot = (): number => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private emit(): void {
		this.snapshot++;
		for (const listener of this.listeners) {
			listener();
		}
	}

	/**
	 * A repo only ever handles its own account. The former "no accountId means
	 * everyone" branch applied scopeless sync events to every open repo.
	 */
	private isForThisAccount(accountId: string): boolean {
		return this.accountId === accountId;
	}

	private isTravelModeVaultHidden(vaultId: string): boolean {
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return true;
		return isVaultHidden(enforcer.getConfig(this.accountId), vaultId);
	}

	private applyTravelModeItemFilter(
		items: VaultRepositoryItem[],
	): VaultRepositoryItem[] {
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return [];
		return enforcer.filterItems(this.accountId, items);
	}

	purgeHiddenVaults(hiddenVaultIds: string[]): void {
		if (hiddenVaultIds.length === 0) {
			return;
		}
		const hidden = new Set(hiddenVaultIds);
		for (const vaultId of hidden) {
			this.vaults.delete(vaultId);
			this.vaultKeyEntries.delete(vaultId);
		}
		for (const [itemId, item] of this.items) {
			if (hidden.has(item.vaultId)) {
				this.items.delete(itemId);
			}
		}
		this.emit();
	}

	private getVaultView(vaultId: string): VaultView {
		const vault = this.vaults.get(vaultId);
		if (!vault) {
			return {
				id: vaultId,
				name: "Unknown",
				type: "personal",
				icon: null,
				imageUrl: null,
			};
		}
		return {
			id: vault.id,
			name: vault.name,
			type: vault.type,
			icon: vault.icon,
			imageUrl: vault.imageUrl,
		};
	}

	private async resolveUserId(): Promise<string> {
		return resolveUserIdForAccount(this.storage, this.accountId);
	}

	private getVersionCandidates(version: number): number[] {
		const normalized =
			Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
		const candidates: number[] = [];
		for (let candidate = normalized; candidate >= 1; candidate -= 1) {
			candidates.push(candidate);
		}
		return candidates;
	}

	private async decryptItemPayload(
		item: CachedEncryptedItem,
		vaultKey: KeyRef,
		userId: string,
	): Promise<string> {
		let lastError: unknown = null;

		for (const version of this.getVersionCandidates(item.version)) {
			try {
				const decrypted = await this.vaultCrypto.decryptItem(
					{
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					{
						vaultId: item.vaultId,
						itemId: item.id,
						version,
						userId,
					},
				);

				if (version !== item.version) {
					console.warn(
						`[VaultRepository] Recovered item ${item.id} with fallback encryption version ${version} (stored version ${item.version})`,
					);
				}

				return decrypted;
			} catch (error) {
				lastError = error;
			}
		}

		throw lastError ?? new Error(`Failed to decrypt item ${item.id}`);
	}

	/**
	 * Which of this account's vault keys, if any, opens a payload its own vault key
	 * could not. Decrypts without AAD on purpose: that isolates "wrong key" from
	 * "wrong encryption context", which is the only distinction worth making here.
	 */
	private async findVaultKeyThatOpens(
		item: CachedEncryptedItem,
	): Promise<string | null> {
		for (const vaultId of this.vaultKeyEntries.keys()) {
			let vaultKey: KeyRef;
			try {
				vaultKey = await this.decryptVaultKey(vaultId);
			} catch {
				continue;
			}
			try {
				await this.crypto.decrypt(
					{
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					null,
				);
				return vaultId;
			} catch {
				// Not this key.
			} finally {
				await this.crypto.destroyKey(vaultKey);
			}
		}
		return null;
	}

	/**
	 * Ids, a version and a length only. This is a password manager: no ciphertext,
	 * no plaintext, no key material may reach a log sink.
	 */
	private async describeUndecryptableItem(
		item: CachedEncryptedItem,
	): Promise<string> {
		const openedBy = await this.findVaultKeyThatOpens(item);
		return `item ${item.id} vault=${item.vaultId} version=${item.version} lastModifiedBy=${item.lastModifiedBy ?? "null"} encryptedDataLength=${item.encryptedData.length} openedByVaultKey=${openedBy ?? "none"}`;
	}

	private async decryptItemBatch(
		items: readonly CachedEncryptedItem[],
	): Promise<
		Array<
			| { item: CachedEncryptedItem; decrypted: VaultRepositoryItem }
			| { item: CachedEncryptedItem; error: unknown }
		>
	> {
		if (items.length === 0) return [];
		const defaultUserId = await this.resolveUserId();
		const vaultKeys = new Map<string, KeyRef>();
		const keyErrors = new Map<string, unknown>();

		try {
			for (const vaultId of new Set(items.map((item) => item.vaultId))) {
				try {
					vaultKeys.set(vaultId, await this.decryptVaultKey(vaultId));
				} catch (error) {
					keyErrors.set(vaultId, error);
				}
			}

			const decryptable = items.flatMap((item) => {
				const vaultKey = vaultKeys.get(item.vaultId);
				return vaultKey ? [{ item, vaultKey }] : [];
			});
			const primary = await this.vaultCrypto.decryptItems(
				decryptable.map(({ item, vaultKey }) => ({
					id: item.id,
					data: {
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					scope: {
						vaultId: item.vaultId,
						itemId: item.id,
						version: item.version,
						userId: item.lastModifiedBy ?? defaultUserId,
					},
				})),
			);

			const outcomeByItem = new Map<
				CachedEncryptedItem,
				| { ok: true; decrypted: VaultRepositoryItem }
				| { ok: false; error: unknown }
			>();
			for (const [index, result] of primary.entries()) {
				const entry = decryptable[index];
				if (!entry) continue;
				if (result.ok) {
					outcomeByItem.set(entry.item, {
						ok: true,
						decrypted: this.buildItem(
							entry.item,
							JSON.parse(result.plaintext) as DecryptedItemData,
						),
					});
					continue;
				}

				let fallbackError: unknown = new Error(result.error);
				for (const version of this.getVersionCandidates(
					entry.item.version,
				).slice(1)) {
					try {
						const plaintext = await this.vaultCrypto.decryptItem(
							{
								ciphertext: entry.item.encryptedData,
								iv: entry.item.encryptionIv,
								algorithm: entry.item.encryptionAlgorithm,
							},
							entry.vaultKey,
							{
								vaultId: entry.item.vaultId,
								itemId: entry.item.id,
								version,
								userId: entry.item.lastModifiedBy ?? defaultUserId,
							},
						);
						console.warn(
							`[VaultRepository] Recovered item ${entry.item.id} with fallback encryption version ${version} (stored version ${entry.item.version})`,
						);
						outcomeByItem.set(entry.item, {
							ok: true,
							decrypted: this.buildItem(
								entry.item,
								JSON.parse(plaintext) as DecryptedItemData,
							),
						});
						fallbackError = null;
						break;
					} catch (error) {
						fallbackError = error;
					}
				}
				if (fallbackError) {
					outcomeByItem.set(entry.item, {
						ok: false,
						error: fallbackError,
					});
				}
			}

			return items.map((item) => {
				const outcome = outcomeByItem.get(item);
				if (outcome?.ok) {
					return { item, decrypted: outcome.decrypted };
				}
				return {
					item,
					error:
						(outcome?.ok === false ? outcome.error : undefined) ??
						keyErrors.get(item.vaultId) ??
						new Error(`Failed to decrypt item ${item.id}`),
				};
			});
		} finally {
			await Promise.all(
				Array.from(vaultKeys.values(), (key) => this.crypto.destroyKey(key)),
			);
		}
	}

	private toCachedItem(item: VaultRepositoryItem): CachedEncryptedItem {
		return {
			id: item.id,
			vaultId: item.vaultId,
			accountId: item.accountId ?? this.accountId,
			accountEmail: item.accountEmail ?? this.accountEmail,
			serverUrl: item.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
			category: item.category,
			favorite: item.favorite,
			encryptedData: item._encrypted.data,
			encryptionIv: item._encrypted.iv,
			encryptionAlgorithm: item._encrypted.algorithm,
			version: item.version,
			lastModifiedBy: item.lastModifiedBy,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			deletedAt: item.deletedAt,
			attachments: item.attachments,
		};
	}

	private mergeVaultKeyEntries(
		vaultKeys: VaultKeyData[] | null | undefined,
	): void {
		if (!vaultKeys) {
			return;
		}

		this.vaultKeyEntries.clear();
		for (const vaultKey of vaultKeys) {
			this.vaultKeyEntries.set(vaultKey.vaultId, vaultKey);

			if (this.vaults.has(vaultKey.vaultId)) {
				continue;
			}

			this.vaults.set(vaultKey.vaultId, {
				id: vaultKey.vaultId,
				accountId: this.accountId,
				accountEmail: this.accountEmail,
				serverUrl: this.serverUrl ?? this.fallbackServerUrl,
				name: vaultKey.vaultName,
				type: vaultKey.vaultType,
				icon: vaultKey.vaultIcon ?? null,
				imageUrl: vaultKey.vaultImageUrl ?? null,
			});
		}
	}

	private async fetchVaultKeysFromServer(
		client: BootstrapItemsClient,
	): Promise<VaultKeyData[] | null> {
		if (!client.vault?.list?.query) {
			return null;
		}

		try {
			const vaults = await client.vault.list.query();
			return vaults.map(toVaultKeyEntry);
		} catch (error) {
			console.error("[VaultRepository] Failed to refresh vault keys:", error);
			return null;
		}
	}

	private async ensureServerUrl(): Promise<void> {
		if (this.serverUrl) {
			return;
		}
		this.serverUrl =
			(await this.storage.getServerUrl(this.accountId)) ??
			this.fallbackServerUrl;
	}

	/**
	 * One `recordPut`, no read-modify-write. Delta sync calls this once per changed
	 * item, which is exactly why `RecordPort` has per-record primitives.
	 */
	private async persistItem(item: CachedEncryptedItem): Promise<boolean> {
		return this.itemCache.upsertCachedItem(item, this.accountId);
	}

	private buildItem(
		cached: CachedEncryptedItem,
		decryptedData: DecryptedItemData,
	): VaultRepositoryItem {
		return {
			id: cached.id,
			vaultId: cached.vaultId,
			accountId: cached.accountId ?? this.accountId,
			accountEmail: cached.accountEmail ?? this.accountEmail,
			serverUrl: cached.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
			category: cached.category as DecryptedItem["category"],
			favorite: cached.favorite,
			createdAt: cached.createdAt,
			updatedAt: cached.updatedAt,
			deletedAt: cached.deletedAt ?? null,
			version: cached.version,
			lastModifiedBy: cached.lastModifiedBy,
			attachments: cached.attachments,
			...decryptedData,
			_encrypted: {
				data: cached.encryptedData,
				iv: cached.encryptionIv,
				algorithm: cached.encryptionAlgorithm,
			},
			vault: this.getVaultView(cached.vaultId),
		};
	}

	private async decryptVaultKey(vaultId: string): Promise<KeyRef> {
		const vaultKeys = await this.storage.getVaultKeys(this.accountId);
		if (!vaultKeys) {
			throw new Error(`No vault key found for vault ${vaultId}.`);
		}

		const vaultKeyData = vaultKeys?.find(
			(vaultKey) => vaultKey.vaultId === vaultId,
		);
		if (!vaultKeyData) {
			throw new Error(`No vault key found for vault ${vaultId}.`);
		}

		const userId = await this.resolveUserId();
		try {
			return await this.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: vaultKeyData.encryptedVaultKey,
				vaultId,
				userId,
				accountId: this.accountId,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "");
			if (
				message !== "Vault key wrap vault mismatch" &&
				message !== "Vault key wrap user mismatch"
			) {
				throw error;
			}

			return this.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: vaultKeyData.encryptedVaultKey,
				accountId: this.accountId,
			});
		}
	}

	async decryptItem(item: CachedEncryptedItem): Promise<VaultRepositoryItem> {
		const vaultKey = await this.decryptVaultKey(item.vaultId);
		try {
			const userId = item.lastModifiedBy ?? (await this.resolveUserId());
			const decryptedData = await this.decryptItemPayload(
				item,
				vaultKey,
				userId,
			);
			return this.buildItem(
				item,
				JSON.parse(decryptedData) as DecryptedItemData,
			);
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	/**
	 * Never throws on a bad payload: sync catch-up applies events one at a time and a
	 * throw here would stop the cursor advancing, wedging sync on the same event forever.
	 */
	async upsertEncrypted(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		if (!(await this.persistItem(item))) {
			return;
		}

		// Sync keeps running on a locked account, and the ciphertext is all the cache
		// wants from it. Decryption waits for the hydrate that follows the unlock, rather
		// than failing once per delta.
		if (await this.isLocked()) {
			this.items.delete(item.id);
			this.emit();
			return;
		}

		try {
			this.items.set(item.id, await this.decryptItem(item));
		} catch (error) {
			// Dropping the stale plaintext also drops its superseded `_encrypted` blob,
			// which a later favorite/delete write would otherwise persist over this ciphertext.
			this.items.delete(item.id);
			console.error(
				`[VaultRepository] Failed to decrypt synced ${await this.describeUndecryptableItem(item)}:`,
				error,
			);
		}
		this.emit();
	}

	async upsertLocal(
		item: DecryptedItem,
		encryptedPayload: EncryptedPayload,
	): Promise<void> {
		const existing = this.items.get(item.id);
		const now = new Date().toISOString();
		const next: VaultRepositoryItem = {
			...existing,
			...item,
			accountId: existing?.accountId ?? this.accountId,
			accountEmail: existing?.accountEmail ?? this.accountEmail,
			serverUrl:
				existing?.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
			updatedAt: existing ? now : item.updatedAt,
			createdAt: existing ? existing.createdAt : item.createdAt,
			deletedAt: existing?.deletedAt ?? null,
			version: (existing?.version ?? 0) + 1,
			lastModifiedBy: existing?.lastModifiedBy ?? null,
			attachments: existing?.attachments,
			_encrypted: {
				data: encryptedPayload.ciphertext,
				iv: encryptedPayload.iv,
				algorithm: encryptedPayload.algorithm,
			},
			vault: existing?.vault ?? this.getVaultView(item.vaultId),
		};

		this.items.set(item.id, next);
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async softDelete(itemId: string): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}
		const now = new Date().toISOString();
		const next: VaultRepositoryItem = {
			...existing,
			deletedAt: now,
			updatedAt: now,
			// Do not increment version — the encrypted payload is unchanged.
			// Version is part of the AEAD context; bumping it without re-encrypting
			// causes a stored-version/ciphertext mismatch during decryption.
		};
		this.items.set(itemId, next);
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async restore(itemId: string): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}
		const now = new Date().toISOString();
		const next: VaultRepositoryItem = {
			...existing,
			deletedAt: null,
			updatedAt: now,
			// Do not increment version — the encrypted payload is unchanged.
			// Version is part of the AEAD context; bumping it without re-encrypting
			// causes a stored-version/ciphertext mismatch during decryption.
		};
		this.items.set(itemId, next);
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async removeItem(itemId: string): Promise<void> {
		this.items.delete(itemId);
		await this.itemCache.removeCachedItem(itemId, this.accountId);
		this.emit();
	}

	replaceItemId(tempId: string, realId: string): void {
		const existing = this.items.get(tempId);
		if (!existing) {
			return;
		}
		this.items.delete(tempId);
		const migrated: VaultRepositoryItem = {
			...existing,
			id: realId,
		};
		this.items.set(realId, migrated);
		void this.itemCache.removeCachedItem(tempId, this.accountId);
		void this.persistItem(this.toCachedItem(migrated));
		this.emit();
	}

	async updateFavorite(itemId: string, favorite: boolean): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}
		const next: VaultRepositoryItem = {
			...existing,
			favorite,
			updatedAt: new Date().toISOString(),
		};
		this.items.set(itemId, next);
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	/**
	 * `decryptedData` is the plaintext the caller sealed into
	 * `newEncryptedPayload`. Re-deriving the encryption context here to decrypt
	 * it back would race the inbound sync stream: an item event landing between
	 * sealing and this write bumps `existing.version`, and the re-derived AAD no
	 * longer matches the sealed one.
	 */
	async moveItem(
		itemId: string,
		targetVaultId: string,
		newEncryptedPayload: EncryptedPayload,
		decryptedData: DecryptedItemData,
	): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}

		const next: VaultRepositoryItem = {
			...existing,
			...decryptedData,
			vaultId: targetVaultId,
			updatedAt: new Date().toISOString(),
			version: existing.version + 1,
			_encrypted: {
				data: newEncryptedPayload.ciphertext,
				iv: newEncryptedPayload.iv,
				algorithm: newEncryptedPayload.algorithm,
			},
			vault: this.getVaultView(targetVaultId),
		};

		this.items.set(itemId, next);
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async hydrate(): Promise<void> {
		if (this.hydrating || (await this.isLocked())) {
			return;
		}

		this.hydrating = true;
		this.emit();

		try {
			getTravelModeEnforcer(this.storage, this.itemCache).assertVerified(
				this.accountId,
			);
			await this.ensureServerUrl();
			const [cachedItems, cachedVaults, cacheMeta, storedVaultKeys] =
				await Promise.all([
					this.itemCache.getCachedItems(this.accountId),
					this.itemCache.getCachedVaults(this.accountId),
					this.itemCache.getItemCacheMetadata(this.accountId),
					this.storage.getVaultKeys(this.accountId),
				]);

			this.items.clear();
			this.vaults.clear();
			this.vaultKeyEntries.clear();

			for (const vault of cachedVaults ?? []) {
				if (!this.serverUrl && vault.serverUrl) {
					this.serverUrl = vault.serverUrl;
				}
				this.vaults.set(vault.id, vault);
			}
			this.mergeVaultKeyEntries(storedVaultKeys);

			for (const cachedItem of cachedItems ?? []) {
				if (!this.serverUrl && cachedItem.serverUrl) {
					this.serverUrl = cachedItem.serverUrl;
				}
			}
			for (const outcome of await this.decryptItemBatch(cachedItems ?? [])) {
				if ("decrypted" in outcome) {
					this.items.set(outcome.item.id, outcome.decrypted);
				} else {
					console.error(
						`[VaultRepository] Failed to decrypt cached ${await this.describeUndecryptableItem(outcome.item)}:`,
						outcome.error,
					);
				}
			}

			this.hasCacheSnapshotFlag =
				!!cachedItems &&
				!!cachedVaults &&
				(cachedItems.length > 0 || cacheMeta !== null);
			this.hydrated = true;
		} finally {
			this.hydrating = false;
			this.emit();
		}
	}

	async hydrateFromServer(client: BootstrapItemsClient): Promise<void> {
		if (await this.isLocked()) {
			return;
		}

		getTravelModeEnforcer(this.storage, this.itemCache).assertVerified(
			this.accountId,
		);
		await this.ensureServerUrl();

		let cursor: string | undefined;
		const staging = await this.itemCache.beginStagedGeneration(this.accountId);
		let refreshedVaultKeys: VaultKeyData[] | null = null;

		try {
			while (true) {
				const page = await client.sync.bootstrapItems.query({
					cursor,
					limit: 500,
				});

				for (const rawItem of page.items) {
					const cachedItem: CachedEncryptedItem = {
						id: rawItem.id,
						vaultId: rawItem.vaultId,
						accountId: this.accountId,
						accountEmail: this.accountEmail,
						serverUrl: this.serverUrl ?? this.fallbackServerUrl,
						category: rawItem.category,
						favorite: rawItem.favorite,
						encryptedData: rawItem.encryptedData,
						encryptionIv: rawItem.encryptionIv,
						encryptionAlgorithm: rawItem.encryptionAlgorithm,
						version: rawItem.version ?? 0,
						lastModifiedBy: rawItem.lastModifiedBy ?? null,
						createdAt: String(rawItem.createdAt),
						updatedAt: String(rawItem.updatedAt),
						deletedAt: rawItem.deletedAt ? String(rawItem.deletedAt) : null,
						attachments: rawItem.attachments,
					};
					await staging.upsertCachedItem(cachedItem);

					await staging.upsertCachedVault({
						...toCachedVaultFields(rawItem.vault),
						accountId: this.accountId,
						accountEmail: this.accountEmail,
						serverUrl: this.serverUrl ?? this.fallbackServerUrl,
					});
				}

				if (!page.hasMore || !page.nextCursor) {
					break;
				}
				cursor = page.nextCursor;
			}

			refreshedVaultKeys = await this.fetchVaultKeysFromServer(client);
			await staging.promote({
				lastFullSyncAt: Date.now(),
				cacheVersion: 1,
			});
		} catch (error) {
			await staging.discard();
			throw error;
		}

		const [cachedItems, cachedVaults] = await Promise.all([
			this.itemCache.getCachedItems(this.accountId),
			this.itemCache.getCachedVaults(this.accountId),
		]);
		const vaultKeys =
			refreshedVaultKeys ?? (await this.storage.getVaultKeys(this.accountId));

		this.vaults.clear();
		for (const vault of cachedVaults ?? []) {
			this.vaults.set(vault.id, vault);
		}

		if (refreshedVaultKeys) {
			await this.storage.storeVaultKeys(refreshedVaultKeys, this.accountId);
		}
		this.mergeVaultKeyEntries(vaultKeys);

		this.items.clear();
		for (const outcome of await this.decryptItemBatch(cachedItems ?? [])) {
			if ("decrypted" in outcome) {
				this.items.set(outcome.item.id, outcome.decrypted);
			} else {
				console.error(
					`[VaultRepository] Failed to decrypt bootstrap ${await this.describeUndecryptableItem(outcome.item)}:`,
					outcome.error,
				);
			}
		}

		this.hasCacheSnapshotFlag = true;
		this.hydrated = true;
		this.emit();
	}

	clear(): void {
		this.items.clear();
		this.vaults.clear();
		this.vaultKeyEntries.clear();
		this.hydrated = false;
		this.hydrating = false;
		this.hasCacheSnapshotFlag = false;
		this.emit();
	}

	// --- SyncItemCache surface (packages/sync/src/types.ts) ---
	async upsertCachedItem(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		await this.upsertEncrypted(item, accountId);
	}

	async removeCachedItem(itemId: string, accountId: string): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		await this.removeItem(itemId);
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		accountId: string,
	): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		this.vaults.set(vault.id, {
			...vault,
			accountId: vault.accountId ?? this.accountId,
			accountEmail: vault.accountEmail ?? this.accountEmail,
			serverUrl: vault.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
		});
		const existingVaultKey = this.vaultKeyEntries.get(vault.id);
		if (existingVaultKey) {
			this.vaultKeyEntries.set(vault.id, {
				...existingVaultKey,
				vaultName: vault.name,
				vaultType: decodeVaultType(vault.type),
				vaultIcon: vault.icon,
				vaultImageUrl: vault.imageUrl,
			});
		}
		await this.itemCache.upsertCachedVault(vault, this.accountId);
		this.emit();
	}

	async syncVaultKeys(
		vaultKeys: VaultKeyData[],
		accountId: string,
	): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}

		const filteredVaultKeys = getTravelModeEnforcer(
			this.storage,
			this.itemCache,
		).filterVaultKeys(this.accountId, vaultKeys);

		this.mergeVaultKeyEntries(filteredVaultKeys);
		await this.storage.storeVaultKeys(filteredVaultKeys, this.accountId);
		this.emit();
	}

	async removeCachedVault(vaultId: string, accountId: string): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		this.vaults.delete(vaultId);
		this.vaultKeyEntries.delete(vaultId);
		for (const [itemId, item] of this.items.entries()) {
			if (item.vaultId === vaultId) {
				this.items.delete(itemId);
			}
		}
		await this.itemCache.removeCachedVault(vaultId, this.accountId);
		this.emit();
	}

	async clearItemCache(accountId: string): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		await this.itemCache.clearItemCache(this.accountId);
		this.clear();
	}

	async encryptWithVaultKey(
		vaultId: string,
		data: DecryptedItemData,
		options?: {
			itemId?: string;
			version?: number;
			userId?: string;
		},
	): Promise<EncryptedData> {
		const vaultKey = await this.decryptVaultKey(vaultId);
		try {
			if (!options?.itemId) {
				return this.crypto.encrypt(JSON.stringify(data), vaultKey, null);
			}
			return this.vaultCrypto.encryptItem(JSON.stringify(data), vaultKey, {
				vaultId,
				itemId: options.itemId,
				version: options.version ?? 1,
				userId: options.userId ?? (await this.resolveUserId()),
			});
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}
}
