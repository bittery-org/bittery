import {
	decryptVaultKey as decryptVaultKeyUtil,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedVaultMetadata,
	EncryptedData,
	ICrypto,
} from "@bittery/types";
import { buildItemEncryptionContext } from "./encryption-context";

export interface VaultView {
	id: string;
	name: string;
	type: string;
	icon: string | null;
	imageUrl: string | null;
}

export interface VaultRepositoryItem extends DecryptedItem {
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
		vault: {
			id: string;
			name: string;
			type: string;
			icon: string | null;
			imageUrl: string | null;
		};
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
			query: () => Promise<
				Array<{
					id: string;
					name: string;
					type: "personal" | "team";
					icon: string | null;
					imageUrl: string | null;
					encryptedVaultKey: string;
					role: "owner" | "admin" | "member" | "read-only";
				}>
			>;
		};
	};
}

export class VaultRepository {
	readonly supportsItemCache = true;
	private readonly fallbackServerUrl = "http://localhost:3000";

	private readonly items = new Map<string, VaultRepositoryItem>();
	private readonly vaults = new Map<string, CachedVaultMetadata>();
	private readonly vaultKeys = new Map<string, Uint8Array>();
	private readonly vaultKeyEntries = new Map<string, VaultKeyData>();
	private readonly listeners = new Set<() => void>();
	private snapshot = 0;
	private hydrated = false;
	private hydrating = false;
	private hasCacheSnapshotFlag = false;
	private serverUrl?: string;

	constructor(
		private readonly crypto: ICrypto,
		private readonly storage: IStorageAdapter,
		private readonly email?: string,
		serverUrl?: string,
	) {
		this.serverUrl = serverUrl;
	}

	getEmail(): string | undefined {
		return this.email;
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

	isHydrating(): boolean {
		return this.hydrating;
	}

	hasCacheSnapshot(): boolean {
		return this.hasCacheSnapshotFlag;
	}

	getAll(): VaultRepositoryItem[] {
		return Array.from(this.items.values()).filter((item) => !item.deletedAt);
	}

	getById(id: string): VaultRepositoryItem | undefined {
		return this.items.get(id);
	}

	getByVault(vaultId: string): VaultRepositoryItem[] {
		return Array.from(this.items.values()).filter(
			(item) => item.vaultId === vaultId && !item.deletedAt,
		);
	}

	getDeleted(): VaultRepositoryItem[] {
		return Array.from(this.items.values()).filter((item) => !!item.deletedAt);
	}

	getVaults(): CachedVaultMetadata[] {
		return Array.from(this.vaults.values());
	}

	getVaultById(vaultId: string): CachedVaultMetadata | undefined {
		return this.vaults.get(vaultId);
	}

	getVaultKeys(): VaultKeyData[] {
		return Array.from(this.vaultKeyEntries.values());
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

	private shouldHandleEmail(email?: string): boolean {
		if (!email || !this.email) {
			return true;
		}
		return this.email.toLowerCase() === email.toLowerCase();
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
		const sessionData = await this.storage.getStoredSessionData?.(this.email);
		if (sessionData?.userId) {
			return sessionData.userId;
		}

		if (this.email) {
			const accountMetadata = await this.storage.getAccountMetadata?.(
				this.email,
			);
			if (accountMetadata?.userId) {
				return accountMetadata.userId;
			}
		}

		const activeUserId = await this.storage.getActiveAccountUserId();
		if (activeUserId) {
			return activeUserId;
		}

		throw new Error("User ID not available for encryption context");
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
		vaultKey: Uint8Array,
		userId: string,
	): Promise<string> {
		let lastError: unknown = null;

		for (const version of this.getVersionCandidates(item.version)) {
			try {
				const context = buildItemEncryptionContext({
					vaultId: item.vaultId,
					itemId: item.id,
					version,
					userId,
				});
				const decrypted = await this.crypto.decrypt(
					{
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					context,
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

	private toCachedItem(item: VaultRepositoryItem): CachedEncryptedItem {
		return {
			id: item.id,
			vaultId: item.vaultId,
			accountEmail: item.accountEmail ?? this.email,
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
				accountEmail: this.email,
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
			return vaults.map((vault) => ({
				vaultId: vault.id,
				vaultName: vault.name,
				vaultType: vault.type,
				vaultIcon: vault.icon,
				vaultImageUrl: vault.imageUrl,
				encryptedVaultKey: vault.encryptedVaultKey,
				role: vault.role,
			}));
		} catch (error) {
			console.error("[VaultRepository] Failed to refresh vault keys:", error);
			return null;
		}
	}

	private async ensureServerUrl(): Promise<void> {
		if (this.serverUrl) {
			return;
		}
		if (!this.email) {
			return;
		}
		this.serverUrl =
			(await this.storage.getServerUrl(this.email)) ?? this.fallbackServerUrl;
	}

	private async persistItem(item: CachedEncryptedItem): Promise<void> {
		if (!this.storage.upsertCachedItem) {
			return;
		}
		await this.storage.upsertCachedItem(item, this.email);
	}

	private buildItem(
		cached: CachedEncryptedItem,
		decryptedData: DecryptedItemData,
	): VaultRepositoryItem {
		return {
			id: cached.id,
			vaultId: cached.vaultId,
			accountEmail: cached.accountEmail ?? this.email,
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

	async decryptVaultKey(vaultId: string): Promise<Uint8Array> {
		const cached = this.vaultKeys.get(vaultId);
		if (cached) {
			return cached;
		}

		const vaultKeys = await this.storage.getVaultKeys(this.email);
		if (!vaultKeys) {
			throw new Error(`No vault key found for vault ${vaultId}.`);
		}

		const vaultKeyData = vaultKeys?.find(
			(vaultKey) => vaultKey.vaultId === vaultId,
		);
		if (!vaultKeyData) {
			throw new Error(`No vault key found for vault ${vaultId}.`);
		}

		const muk = await this.storage.getMasterUnlockKey(this.email);
		if (!muk) {
			throw new Error("Master Unlock Key not available. Please log in again.");
		}
		const userId = await this.resolveUserId();

		const encryptedPrivateKey = await this.storage.getEncryptedPrivateKey(
			this.email,
		);

		let decrypted: Uint8Array;
		try {
			decrypted = await decryptVaultKeyUtil({
				encryptedVaultKey: vaultKeyData.encryptedVaultKey,
				masterUnlockKey: muk,
				encryptedPrivateKey,
				expectedVaultId: vaultId,
				expectedUserId: userId,
				crypto: this.crypto as unknown as VaultKeyCryptoProvider,
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

			decrypted = await decryptVaultKeyUtil({
				encryptedVaultKey: vaultKeyData.encryptedVaultKey,
				masterUnlockKey: muk,
				encryptedPrivateKey,
				crypto: this.crypto as unknown as VaultKeyCryptoProvider,
			});
		}

		this.vaultKeys.set(vaultId, decrypted);
		return decrypted;
	}

	async decryptItem(item: CachedEncryptedItem): Promise<VaultRepositoryItem> {
		const vaultKey = await this.decryptVaultKey(item.vaultId);
		const userId = item.lastModifiedBy ?? (await this.resolveUserId());
		const decryptedData = await this.decryptItemPayload(item, vaultKey, userId);
		return this.buildItem(item, JSON.parse(decryptedData) as DecryptedItemData);
	}

	async upsertEncrypted(
		item: CachedEncryptedItem,
		email?: string,
	): Promise<void> {
		if (!this.shouldHandleEmail(email)) {
			return;
		}
		const decrypted = await this.decryptItem(item);
		this.items.set(item.id, decrypted);
		await this.persistItem(item);
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
			accountEmail: existing?.accountEmail ?? this.email,
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
			version: existing.version + 1,
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
			version: existing.version + 1,
		};
		this.items.set(itemId, next);
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async removeItem(itemId: string): Promise<void> {
		this.items.delete(itemId);
		await this.storage.removeCachedItem?.(itemId, this.email);
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
		void this.storage.removeCachedItem?.(tempId, this.email);
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

	async moveItem(
		itemId: string,
		targetVaultId: string,
		newEncryptedPayload: EncryptedPayload,
	): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}

		const targetVaultKey = await this.decryptVaultKey(targetVaultId);
		const context = buildItemEncryptionContext({
			vaultId: targetVaultId,
			itemId: itemId,
			version: (existing.version ?? 1) + 1,
			userId: await this.resolveUserId(),
		});
		const decrypted = await this.crypto.decrypt(
			{
				ciphertext: newEncryptedPayload.ciphertext,
				iv: newEncryptedPayload.iv,
				algorithm: newEncryptedPayload.algorithm,
			},
			targetVaultKey,
			context,
		);
		const parsed = JSON.parse(decrypted) as DecryptedItemData;

		const next: VaultRepositoryItem = {
			...existing,
			...parsed,
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
		if (this.hydrating) {
			return;
		}

		this.hydrating = true;
		this.emit();

		try {
			await this.ensureServerUrl();
			const [cachedItems, cachedVaults, cacheMeta, storedVaultKeys] =
				await Promise.all([
					this.storage.getCachedItems?.(this.email),
					this.storage.getCachedVaults?.(this.email),
					this.storage.getItemCacheMetadata?.(this.email),
					this.storage.getVaultKeys(this.email),
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
				try {
					const decrypted = await this.decryptItem(cachedItem);
					this.items.set(cachedItem.id, decrypted);
				} catch (error) {
					console.error(
						`[VaultRepository] Failed to decrypt cached item ${cachedItem.id}:`,
						error,
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
		await this.ensureServerUrl();

		let cursor: string | undefined;
		const cachedItems: CachedEncryptedItem[] = [];
		const vaults = new Map<string, CachedVaultMetadata>();

		while (true) {
			const page = await client.sync.bootstrapItems.query({
				cursor,
				limit: 500,
			});

			for (const rawItem of page.items) {
				const cachedItem: CachedEncryptedItem = {
					id: rawItem.id,
					vaultId: rawItem.vaultId,
					accountEmail: this.email,
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
				cachedItems.push(cachedItem);

				vaults.set(rawItem.vault.id, {
					id: rawItem.vault.id,
					accountEmail: this.email,
					serverUrl: this.serverUrl ?? this.fallbackServerUrl,
					name: rawItem.vault.name,
					type: rawItem.vault.type,
					icon: rawItem.vault.icon,
					imageUrl: rawItem.vault.imageUrl,
				});
			}

			if (!page.hasMore || !page.nextCursor) {
				break;
			}
			cursor = page.nextCursor;
		}

		const refreshedVaultKeys = await this.fetchVaultKeysFromServer(client);
		const vaultKeys =
			refreshedVaultKeys ?? (await this.storage.getVaultKeys(this.email));

		this.vaults.clear();
		for (const vault of vaults.values()) {
			this.vaults.set(vault.id, vault);
		}

		if (refreshedVaultKeys) {
			await this.storage.storeVaultKeys(refreshedVaultKeys, this.email);
		}
		this.mergeVaultKeyEntries(vaultKeys);

		this.items.clear();
		for (const cachedItem of cachedItems) {
			try {
				const decrypted = await this.decryptItem(cachedItem);
				this.items.set(cachedItem.id, decrypted);
			} catch (error) {
				console.error(
					`[VaultRepository] Failed to decrypt bootstrap item ${cachedItem.id}:`,
					error,
				);
			}
		}

		await Promise.all([
			this.storage.setCachedItems?.(cachedItems, this.email),
			this.storage.setCachedVaults?.(
				Array.from(this.vaults.values()),
				this.email,
			),
			this.storage.setItemCacheMetadata?.(
				{
					lastFullSyncAt: Date.now(),
					itemCount: cachedItems.length,
					cacheVersion: 1,
				},
				this.email,
			),
		]);

		this.hasCacheSnapshotFlag = true;
		this.hydrated = true;
		this.emit();
	}

	clear(): void {
		this.items.clear();
		this.vaults.clear();
		this.vaultKeys.clear();
		this.vaultKeyEntries.clear();
		this.hydrated = false;
		this.hydrating = false;
		this.hasCacheSnapshotFlag = false;
		this.emit();
	}

	// ItemCacheAdapter compatibility for incremental migration.
	async upsertCachedItem(
		item: CachedEncryptedItem,
		email?: string,
	): Promise<void> {
		await this.upsertEncrypted(item, email);
	}

	async removeCachedItem(itemId: string, email?: string): Promise<void> {
		if (!this.shouldHandleEmail(email)) {
			return;
		}
		await this.removeItem(itemId);
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		email?: string,
	): Promise<void> {
		if (!this.shouldHandleEmail(email)) {
			return;
		}
		this.vaults.set(vault.id, {
			...vault,
			accountEmail: vault.accountEmail ?? this.email,
			serverUrl: vault.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
		});
		const existingVaultKey = this.vaultKeyEntries.get(vault.id);
		if (existingVaultKey) {
			this.vaultKeyEntries.set(vault.id, {
				...existingVaultKey,
				vaultName: vault.name,
				vaultType: vault.type as VaultKeyData["vaultType"],
				vaultIcon: vault.icon,
				vaultImageUrl: vault.imageUrl,
			});
		}
		await this.storage.upsertCachedVault?.(vault, this.email);
		this.emit();
	}

	async syncVaultKeys(
		vaultKeys: VaultKeyData[],
		email?: string,
	): Promise<void> {
		if (!this.shouldHandleEmail(email)) {
			return;
		}

		this.mergeVaultKeyEntries(vaultKeys);
		await this.storage.storeVaultKeys(vaultKeys, this.email);
		this.emit();
	}

	async removeCachedVault(vaultId: string, email?: string): Promise<void> {
		if (!this.shouldHandleEmail(email)) {
			return;
		}
		this.vaults.delete(vaultId);
		this.vaultKeyEntries.delete(vaultId);
		for (const [itemId, item] of this.items.entries()) {
			if (item.vaultId === vaultId) {
				this.items.delete(itemId);
			}
		}
		await this.storage.removeCachedVault?.(vaultId, this.email);
		this.emit();
	}

	async clearItemCache(email?: string): Promise<void> {
		if (!this.shouldHandleEmail(email)) {
			return;
		}
		await this.storage.clearItemCache?.(this.email);
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
		if (!options?.itemId) {
			return this.crypto.encrypt(JSON.stringify(data), vaultKey);
		}
		const context = buildItemEncryptionContext({
			vaultId,
			itemId: options.itemId,
			version: options.version ?? 1,
			userId: options.userId ?? (await this.resolveUserId()),
		});
		return this.crypto.encrypt(JSON.stringify(data), vaultKey, context);
	}
}
