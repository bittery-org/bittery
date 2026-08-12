import type { CryptoPort, KeyRef } from "@bittery/crypto-port";
import { ApiError, isApiErrorStatus } from "@bittery/shared/api-client";
import {
	type ItemVaultSummary,
	toCachedAttachment,
	toCachedItem,
	toItemVaultSummary,
	toRawItem,
} from "@bittery/shared/item-mapping";
import { applyPasswordHistoryOnPasswordChange } from "@bittery/shared/password-history";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import {
	type ServerVaultSummary,
	toCachedVaultFields,
} from "@bittery/shared/vault-mapping";
import type { AccountStore, ItemCache } from "@bittery/storage";
import {
	resolveAccountScopeId,
	resolveUserIdForScope,
} from "@bittery/storage/account-id";
import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemSyncAcknowledgement,
	ItemSyncCommand,
	RawEncryptedItem,
	RawEncryptedItemWithVault,
} from "@bittery/types";
import type {
	AccountInfo,
	AccountResolver,
	DefaultApiClient,
} from "./account-resolver";
import {
	decryptAttachmentParts,
	encodeAttachmentBlobEnvelope,
	encryptAttachmentParts,
	parseAttachmentBlobEnvelope,
} from "./attachment-crypto";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import type {
	ItemWriteScope,
	StoredItemCiphertext,
	VaultCrypto,
} from "./vault-crypto";

export type { RawEncryptedItem, RawEncryptedItemWithVault };

export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

/**
 * Kept as a name, not a shape: `version`, `lastModifiedBy` and `attachments` used to be
 * re-stated here because {@link RawEncryptedItem} left them optional. The contract makes
 * all three part of every item payload, so restating them can only drift.
 */
export type RawEncryptedItemWithVersion = RawEncryptedItem;

export interface MultiAccountItem extends DecryptedItem {
	_encrypted?: {
		data: string;
		iv: string;
		algorithm: string;
	};
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
}

export interface MultiAccountDeletedItem {
	id: string;
	vaultId: string;
	category: ItemCategory;
	favorite: boolean;
	createdAt: string | Date;
	updatedAt: string | Date;
	deletedAt: string | Date;
	title?: string;
	vault: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
	[key: string]: any;
}

export interface FetchDecryptedItemResult {
	rawItem: RawEncryptedItemWithVersion | null;
	decryptedData: DecryptedItemData | null;
}

export interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountEmail?: string;
}

export interface CreateItemResult {
	itemId: string;
	_encryptedData: EncryptedPayload;
	_accountEmail?: string;
}

export interface UpdateItemInput {
	itemId: string;
	vaultId: string;
	data: Partial<DecryptedItemData>;
	accountEmail?: string;
}

export interface UpdateItemResult {
	_encryptedData: EncryptedPayload;
	_accountEmail?: string;
}

export interface MoveItemInput {
	itemId: string;
	sourceVaultId: string;
	targetVaultId: string;
	category: ItemCategory;
	decryptedData: DecryptedItemData;
	sourceAccountEmail?: string;
	targetAccountEmail?: string;
}

export interface MoveItemResult {
	crossAccount: boolean;
	newItemId?: string;
	_encryptedData: EncryptedPayload;
	_sourceAccountEmail?: string;
	_targetAccountEmail?: string;
}

/** Anything carrying an item's ciphertext and the binding it was sealed under. */
type DecryptableItemRecord = StoredItemCiphertext;

type ApiVaultSummary =
	| (Omit<ServerVaultSummary, "icon" | "imageUrl"> & {
			icon?: string | null;
			imageUrl?: string | null;
	  })
	| null
	| undefined;

type ApiAttachment = CachedAttachment;

function normalizeVaultSummary(
	vault: ApiVaultSummary,
	vaultId: string,
): ItemVaultSummary {
	// The wire spells it `vaultType`; `toCachedVaultFields` is the only decoder of that name.
	return toItemVaultSummary(
		vault
			? toCachedVaultFields({
					...vault,
					icon: vault.icon ?? null,
					imageUrl: vault.imageUrl ?? null,
				})
			: undefined,
		vaultId,
	);
}

function normalizeRawItemWithVault<
	TItem extends Omit<RawEncryptedItem, "attachments"> & {
		attachments?: readonly ApiAttachment[];
		vault?: ApiVaultSummary;
	},
>(item: TItem): RawEncryptedItemWithVault {
	return {
		...item,
		attachments: item.attachments?.map(toCachedAttachment),
		vault: normalizeVaultSummary(item.vault, item.vaultId),
	};
}

function strongItemEtag(version: number): string {
	return `"${version}"`;
}

interface ItemServiceDeps {
	storage: AccountStore;
	/** Sibling of `storage`, never reachable through it. See packages/storage/CONTEXT.md §3. */
	itemCache: ItemCache;
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
	accounts: AccountResolver;
}

export class ItemService {
	private readonly storage: AccountStore;
	private readonly itemCache: ItemCache;
	private readonly crypto: CryptoPort;
	private readonly vaultCrypto: VaultCrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: ItemServiceDeps) {
		this.storage = deps.storage;
		this.itemCache = deps.itemCache;
		this.crypto = deps.crypto;
		this.vaultCrypto = deps.vaultCrypto;
		this.accounts = deps.accounts;
	}

	async generateItemId(): Promise<string> {
		return this.crypto.generateUuid();
	}

	private async resolveUserId(scope?: string): Promise<string> {
		return resolveUserIdForScope(this.storage, scope);
	}

	async encryptItemData(
		data: DecryptedItemData,
		vaultKey: KeyRef,
		context: ItemWriteScope,
	): Promise<EncryptedPayload> {
		return this.vaultCrypto.encryptItem(
			JSON.stringify(data),
			vaultKey,
			context,
		);
	}

	mergeItemUpdate(
		existing: DecryptedItemData,
		update: Partial<DecryptedItemData>,
		category: ItemCategory,
	): DecryptedItemData {
		const merged: DecryptedItemData = {
			...existing,
			...update,
		};

		if (category === "login") {
			merged.passwordHistory = applyPasswordHistoryOnPasswordChange({
				passwordHistory: merged.passwordHistory,
				previousPassword: existing.password,
				nextPassword: merged.password,
			});
		}

		return merged;
	}

	private async decryptItemPayload(
		item: DecryptableItemRecord,
		vaultKey: KeyRef,
	): Promise<string> {
		return this.vaultCrypto.decryptStoredItem(item, vaultKey);
	}

	private async getVaultKey(
		vaultId: string,
		scope?: string,
	): Promise<KeyRef | null> {
		const accountId = await resolveAccountScopeId(this.storage, scope);
		return this.vaultCrypto.getVaultKey({
			vaultId,
			accountId,
		});
	}

	private buildRawItemsFromCache(
		cachedItems: CachedEncryptedItem[],
		cachedVaults: CachedVaultMetadata[],
		includeDeleted: boolean,
	): RawEncryptedItemWithVault[] {
		const vaultMap = new Map<string, CachedVaultMetadata>();
		for (const vault of cachedVaults) {
			vaultMap.set(vault.id, vault);
		}

		return cachedItems
			.filter((item) => (includeDeleted ? !!item.deletedAt : !item.deletedAt))
			.map((item) => toRawItem(item, vaultMap.get(item.vaultId)));
	}

	private toCachedItems(
		rawItems: RawEncryptedItemWithVault[],
		account: Pick<AccountInfo, "email" | "serverUrl">,
	): CachedEncryptedItem[] {
		return rawItems.map((item) =>
			toCachedItem(item, {
				accountEmail: account.email,
				serverUrl: account.serverUrl,
			}),
		);
	}

	private toCachedVaults(
		rawItems: RawEncryptedItemWithVault[],
		account: Pick<AccountInfo, "email" | "serverUrl">,
	): CachedVaultMetadata[] {
		const seen = new Set<string>();
		const vaults: CachedVaultMetadata[] = [];

		for (const item of rawItems) {
			if (seen.has(item.vault.id)) {
				continue;
			}
			seen.add(item.vault.id);
			vaults.push({
				id: item.vault.id,
				accountEmail: account.email,
				serverUrl: account.serverUrl,
				name: item.vault.name,
				type: item.vault.type,
				icon: item.vault.icon,
				imageUrl: item.vault.imageUrl,
			});
		}

		return vaults;
	}

	private async fetchBootstrapItems(
		client: DefaultApiClient,
	): Promise<RawEncryptedItemWithVault[]> {
		const allItems: RawEncryptedItemWithVault[] = [];
		let cursor: string | null = null;

		while (true) {
			const { data: page } = await client.sync.bootstrap({
				cursor: cursor ?? undefined,
				limit: 500,
			});

			allItems.push(
				...page.items.map((item) => normalizeRawItemWithVault(item)),
			);
			if (!page.hasMore || !page.nextCursor) {
				break;
			}

			cursor = page.nextCursor ?? null;
		}

		return allItems;
	}

	async fetchAndDecryptItems(
		accounts: AccountInfo[],
	): Promise<MultiAccountItem[]> {
		if (accounts.length === 0) return [];

		const results = await Promise.all(
			accounts.map(async (account) => {
				try {
					let rawItems: RawEncryptedItemWithVault[];

					const [cachedItems, cachedVaults] = await Promise.all([
						this.itemCache.getCachedItems(account.accountId),
						this.itemCache.getCachedVaults(account.accountId),
					]);

					if (cachedItems && cachedVaults && cachedItems.length > 0) {
						rawItems = this.buildRawItemsFromCache(
							cachedItems,
							cachedVaults,
							false,
						);
					} else {
						rawItems = await this.fetchBootstrapItems(account.apiClient);
						const cachedItems = this.toCachedItems(rawItems, account);
						const cachedVaults = this.toCachedVaults(rawItems, account);
						await Promise.all([
							this.itemCache.setCachedItems(cachedItems, account.accountId),
							this.itemCache.setCachedVaults(cachedVaults, account.accountId),
							this.itemCache.setItemCacheMetadata(
								{
									lastFullSyncAt: Date.now(),
									itemCount: cachedItems.length,
									cacheVersion: 1,
								},
								account.accountId,
							),
						]);
					}

					// Fail-closed travel-mode guard: require a verified policy and
					// drop any items belonging to hidden vaults before decrypting,
					// mirroring VaultRepository. Prevents hidden-vault leakage if
					// this path is wired into a UI later.
					const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
					enforcer.assertVerified(account.accountId);
					rawItems = enforcer.filterItems(account.accountId, rawItems);

					const vaultKeyCache = new Map<string, KeyRef>();
					try {
						for (const vaultId of new Set(
							rawItems.map((item) => item.vaultId),
						)) {
							try {
								const key = await this.getVaultKey(vaultId, account.accountId);
								if (key) vaultKeyCache.set(vaultId, key);
							} catch (error) {
								console.error(
									`[ItemService] Failed to open vault key ${vaultId} for ${account.email}:`,
									error,
								);
							}
						}
						const decrypted = await Promise.all(
							rawItems.map(
								async (rawItem): Promise<MultiAccountItem | null> => {
									try {
										const vaultKey = vaultKeyCache.get(rawItem.vaultId);

										if (!vaultKey) {
											throw new Error(
												`No vault key for vault ${rawItem.vaultId}`,
											);
										}

										const decryptedData = await this.decryptItemPayload(
											rawItem,
											vaultKey,
										);

										const parsedData = JSON.parse(
											decryptedData,
										) as DecryptedItemData;
										return {
											id: rawItem.id,
											vaultId: rawItem.vaultId,
											category: rawItem.category as ItemCategory,
											favorite: rawItem.favorite,
											createdAt: String(rawItem.createdAt),
											updatedAt: String(rawItem.updatedAt),
											...parsedData,
											_encrypted: {
												data: rawItem.encryptedData,
												iv: rawItem.encryptionIv,
												algorithm: rawItem.encryptionAlgorithm,
											},
											vault: toItemVaultSummary(rawItem.vault, rawItem.vaultId),
										} as MultiAccountItem;
									} catch (error) {
										console.error(
											`[ItemService] Failed to decrypt item ${rawItem.id} for ${account.email}:`,
											error,
										);
										return null;
									}
								},
							),
						);

						return decrypted.filter(
							(item): item is MultiAccountItem => item !== null,
						);
					} finally {
						await Promise.all(
							Array.from(vaultKeyCache.values(), (key) =>
								this.crypto.destroyKey(key),
							),
						);
					}
				} catch (error) {
					console.error(
						`[ItemService] Failed to fetch items for ${account.email}:`,
						error,
					);
					return [];
				}
			}),
		);

		return results.flat();
	}

	async fetchVaultItems(
		vaultId: string,
		accounts: AccountInfo[],
	): Promise<DecryptedItem[]> {
		if (!vaultId || accounts.length === 0) {
			return [];
		}

		let ownerAccount: AccountInfo | null = null;
		for (const account of accounts) {
			const vaultKeys = await this.storage.getVaultKeys(account.accountId);
			if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === vaultId)) {
				ownerAccount = account;
				break;
			}
		}

		if (!ownerAccount) {
			throw new Error(`No account found with access to vault ${vaultId}`);
		}

		let rawItems: RawEncryptedItem[];
		const cachedItems = await this.itemCache.getCachedItems(
			ownerAccount.accountId,
		);
		if (cachedItems && cachedItems.length > 0) {
			const vaultItems = cachedItems.filter(
				(item) => item.vaultId === vaultId && !item.deletedAt,
			);
			if (vaultItems.length > 0) {
				rawItems = vaultItems.map((item) => toRawItem(item));
			} else {
				rawItems = (
					await ownerAccount.apiClient.items.listInVault(vaultId)
				).data.map((item) => ({
					...item,
					attachments: item.attachments.map(toCachedAttachment),
				}));
			}
		} else {
			rawItems = (
				await ownerAccount.apiClient.items.listInVault(vaultId)
			).data.map((item) => ({
				...item,
				attachments: item.attachments.map(toCachedAttachment),
			}));
		}

		// Fail-closed travel-mode guard: require a verified policy for the owning
		// account and drop items in hidden vaults (a hidden target vault yields no
		// items) before decrypting, mirroring VaultRepository.
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		enforcer.assertVerified(ownerAccount.accountId);
		rawItems = enforcer.filterItems(ownerAccount.accountId, rawItems);

		if (rawItems.length === 0) {
			return [];
		}

		const vaultKey = await this.getVaultKey(vaultId, ownerAccount.accountId);
		if (!vaultKey) {
			throw new Error(`No vault key found for vault ${vaultId}`);
		}
		try {
			const decryptedItems = await Promise.all(
				rawItems.map(async (item) => {
					try {
						const decryptedData = await this.decryptItemPayload(item, vaultKey);

						const parsedData = JSON.parse(decryptedData) as DecryptedItemData;
						return {
							id: item.id,
							vaultId: item.vaultId,
							category: item.category as ItemCategory,
							favorite: item.favorite,
							createdAt: String(item.createdAt),
							updatedAt: String(item.updatedAt),
							...parsedData,
						} satisfies DecryptedItem;
					} catch (error) {
						console.error(
							`[ItemService] Failed to decrypt item ${item.id}:`,
							error,
						);
						return {
							id: item.id,
							vaultId: item.vaultId,
							category: item.category as ItemCategory,
							favorite: item.favorite,
							createdAt: String(item.createdAt),
							updatedAt: String(item.updatedAt),
							title: "[Decryption Failed]",
						} satisfies DecryptedItem;
					}
				}),
			);

			return decryptedItems;
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	async fetchAndDecryptItem(
		itemId: string,
		defaultClient: DefaultApiClient,
		accountEmail?: string,
	): Promise<FetchDecryptedItemResult> {
		if (!itemId) {
			return { rawItem: null, decryptedData: null };
		}

		let rawItem: RawEncryptedItemWithVersion | null = null;

		const accountId = await resolveAccountScopeId(this.storage, accountEmail);
		const cachedItems = await this.itemCache.getCachedItems(accountId);
		const cached = cachedItems?.find((item) => item.id === itemId);
		if (cached) {
			rawItem = toRawItem(cached);
		}

		if (!rawItem) {
			const client = await this.accounts.getClientForAccount(
				defaultClient,
				accountId,
			);
			const { data: fetched } = await client.items.get(itemId);
			// Decoded exactly as if it had come off the cache, so the two branches of this
			// method cannot disagree about a field.
			rawItem = toRawItem(toCachedItem(fetched, {}));
		}
		if (!rawItem) {
			throw new Error("Item was not returned by the server");
		}

		const vaultKey = await this.getVaultKey(rawItem.vaultId, accountEmail);

		if (!vaultKey) {
			throw new Error(
				`No vault key found for decryption${accountEmail ? ` (account: ${accountEmail})` : ""}`,
			);
		}
		try {
			const decryptedJson = await this.decryptItemPayload(rawItem, vaultKey);

			return {
				rawItem,
				decryptedData: JSON.parse(decryptedJson) as DecryptedItemData,
			};
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	async fetchDeletedItems(
		accounts: AccountInfo[],
	): Promise<MultiAccountDeletedItem[]> {
		if (accounts.length === 0) return [];

		const results = await Promise.all(
			accounts.map(async (account) => {
				try {
					let rawItems: RawEncryptedItemWithVault[];

					const [cachedItems, cachedVaults] = await Promise.all([
						this.itemCache.getCachedItems(account.accountId),
						this.itemCache.getCachedVaults(account.accountId),
					]);

					if (cachedItems && cachedVaults) {
						const deletedItems = cachedItems.filter((item) => !!item.deletedAt);
						if (deletedItems.length > 0) {
							rawItems = this.buildRawItemsFromCache(
								cachedItems,
								cachedVaults,
								true,
							);
						} else {
							rawItems = (await account.apiClient.items.listTrashed()).data.map(
								(item) => normalizeRawItemWithVault(item),
							);
						}
					} else {
						rawItems = (await account.apiClient.items.listTrashed()).data.map(
							(item) => normalizeRawItemWithVault(item),
						);
					}

					// Fail-closed travel-mode guard: require a verified policy and
					// drop items in hidden vaults before decrypting, mirroring
					// VaultRepository, so deleted-item listings can't leak
					// hidden-vault data if wired into a UI later.
					const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
					enforcer.assertVerified(account.accountId);
					rawItems = enforcer.filterItems(account.accountId, rawItems);

					const vaultKeyCache = new Map<string, KeyRef>();
					try {
						for (const vaultId of new Set(
							rawItems.map((item) => item.vaultId),
						)) {
							try {
								const key = await this.getVaultKey(vaultId, account.accountId);
								if (key) vaultKeyCache.set(vaultId, key);
							} catch (error) {
								console.error(
									`[ItemService] Failed to open vault key ${vaultId} for ${account.email}:`,
									error,
								);
							}
						}
						const decrypted = await Promise.all(
							rawItems.map(
								async (rawItem): Promise<MultiAccountDeletedItem | null> => {
									try {
										const vaultKey = vaultKeyCache.get(rawItem.vaultId);

										if (!vaultKey) {
											throw new Error(
												`No vault key for vault ${rawItem.vaultId}`,
											);
										}

										const decryptedData = await this.decryptItemPayload(
											rawItem,
											vaultKey,
										);

										const parsedData = JSON.parse(decryptedData) as Record<
											string,
											unknown
										>;
										const deletedAt = rawItem.deletedAt
											? rawItem.deletedAt
											: new Date().toISOString();

										return {
											id: rawItem.id,
											vaultId: rawItem.vaultId,
											category: rawItem.category as ItemCategory,
											favorite: rawItem.favorite,
											createdAt: rawItem.createdAt,
											updatedAt: rawItem.updatedAt,
											deletedAt,
											...parsedData,
											vault: toItemVaultSummary(rawItem.vault, rawItem.vaultId),
										} as MultiAccountDeletedItem;
									} catch (error) {
										console.error(
											`[ItemService] Failed to decrypt deleted item ${rawItem.id} for ${account.email}:`,
											error,
										);
										return null;
									}
								},
							),
						);

						return decrypted.filter(
							(item): item is MultiAccountDeletedItem => item !== null,
						);
					} finally {
						await Promise.all(
							Array.from(vaultKeyCache.values(), (key) =>
								this.crypto.destroyKey(key),
							),
						);
					}
				} catch (error) {
					console.error(
						`[ItemService] Failed to fetch deleted items for ${account.email}:`,
						error,
					);
					return [];
				}
			}),
		);

		return results.flat();
	}

	async createItem(
		input: CreateItemInput,
		defaultClient: DefaultApiClient,
	): Promise<CreateItemResult> {
		const vaultKey = await this.getVaultKey(input.vaultId, input.accountEmail);
		if (!vaultKey) {
			throw new Error("No vault key found. Please sign in again.");
		}
		try {
			const itemId = await this.generateItemId();
			const userId = await this.resolveUserId(input.accountEmail);
			const context: ItemWriteScope = {
				vaultId: input.vaultId,
				itemId,
				version: 1,
				userId,
			};

			const encryptedData = await this.vaultCrypto.encryptItem(
				JSON.stringify(input.data),
				vaultKey,
				context,
			);

			const accountId = await resolveAccountScopeId(
				this.storage,
				input.accountEmail,
			);
			const client = await this.accounts.getClientForAccount(
				defaultClient,
				accountId,
			);

			const { data: result } = await client.items.create(
				input.vaultId,
				itemId,
				{
					category: input.category,
					encryptedData: encryptedData.ciphertext,
					encryptionIv: encryptedData.iv,
					encryptionAlgorithm: encryptedData.algorithm,
				},
			);

			const fallbackId =
				result.id && result.id !== input.vaultId ? result.id : undefined;
			const createdItemId = result.itemId ?? fallbackId;
			if (!createdItemId) {
				throw new Error("Failed to create item");
			}
			if (createdItemId !== itemId) {
				throw new Error("Server returned mismatched item ID");
			}

			return {
				itemId,
				_encryptedData: encryptedData,
				_accountEmail: input.accountEmail,
			};
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	async updateItem(
		input: UpdateItemInput,
		defaultClient: DefaultApiClient,
	): Promise<UpdateItemResult> {
		const vaultKey = await this.getVaultKey(input.vaultId, input.accountEmail);
		if (!vaultKey) {
			throw new Error("No vault key found. Please sign in again.");
		}
		try {
			let encryptedPayload: Partial<DecryptedItemData> = input.data;
			const { rawItem, decryptedData } = await this.fetchAndDecryptItem(
				input.itemId,
				defaultClient,
				input.accountEmail,
			);

			if (rawItem?.category === "login" && decryptedData) {
				const mergedLoginData: DecryptedItemData = {
					...decryptedData,
					...input.data,
				};

				mergedLoginData.passwordHistory = applyPasswordHistoryOnPasswordChange({
					passwordHistory: mergedLoginData.passwordHistory,
					previousPassword: decryptedData.password,
					nextPassword: mergedLoginData.password,
				});

				encryptedPayload = mergedLoginData;
			}

			const userId = await this.resolveUserId(input.accountEmail);
			const nextVersion = (rawItem?.version ?? 1) + 1;
			const context: ItemWriteScope = {
				vaultId: input.vaultId,
				itemId: input.itemId,
				version: nextVersion,
				userId,
			};

			const encryptedData = await this.vaultCrypto.encryptItem(
				JSON.stringify(encryptedPayload),
				vaultKey,
				context,
			);

			const accountId = await resolveAccountScopeId(
				this.storage,
				input.accountEmail,
			);
			const client = await this.accounts.getClientForAccount(
				defaultClient,
				accountId,
			);
			if (!rawItem) {
				throw new Error("Cannot update an item without its current version");
			}

			await client.items.update(
				input.itemId,
				{
					encryptedData: encryptedData.ciphertext,
					encryptionIv: encryptedData.iv,
					encryptionAlgorithm: encryptedData.algorithm,
				},
				{ etag: strongItemEtag(rawItem.version) },
			);

			return {
				_encryptedData: encryptedData,
				_accountEmail: input.accountEmail,
			};
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	/**
	 * Copy every attachment from the source item onto the target item during a
	 * cross-account move. Throws on the first failure so the caller can keep the
	 * source intact. No-op (and no source vault-key lookup) when the item has no
	 * attachments.
	 */
	private async migrateAttachmentsForCrossAccountMove(params: {
		sourceClient: DefaultApiClient;
		targetClient: DefaultApiClient;
		sourceItemId: string;
		targetItemId: string;
		sourceVaultId: string;
		targetVaultId: string;
		sourceAccountEmail?: string;
		targetVaultKey: KeyRef;
		targetUserId: string;
		attachmentAttemptId?: string;
	}): Promise<void> {
		const { data: attachments } = await params.sourceClient.attachments.list(
			params.sourceItemId,
		);
		if (!attachments || attachments.length === 0) {
			return;
		}

		const sourceVaultKey = await this.getVaultKey(
			params.sourceVaultId,
			params.sourceAccountEmail,
		);
		if (!sourceVaultKey) {
			throw new Error(
				"Cannot access the source vault key to migrate attachments. Please unlock the source account.",
			);
		}
		try {
			for (const attachment of attachments) {
				// Fetch the encrypted blob envelope from object storage.
				const { data: download } =
					await params.sourceClient.attachments.createDownloadUrl(
						attachment.id,
					);
				const response = await fetch(download.downloadUrl);
				if (!response.ok) {
					throw new Error(
						`Failed to download attachment ${attachment.id} during cross-account move.`,
					);
				}
				const blobEnvelope = parseAttachmentBlobEnvelope(await response.text());

				// Decrypt under the source vault key and the attachment's persisted scope.
				const decrypted = await decryptAttachmentParts(
					this.vaultCrypto,
					sourceVaultKey,
					{
						vaultId: params.sourceVaultId,
						attachmentKey: attachment.storageKey,
						userId: attachment.uploadedBy,
					},
					{
						blobEnvelope,
						encryptedName: attachment.encryptedName,
						encryptedContentType: attachment.encryptedContentType,
						encryptionIv: attachment.encryptionIv,
						encryptedContentTypeIv: attachment.encryptedContentTypeIv,
						encryptionAlgorithm: attachment.encryptionAlgorithm,
					},
				);

				// Mint a NEW server-signed storage key on the target. Quota errors
				// (file-too-large / storage-limit-reached) reject here and propagate,
				// aborting the move with the source left intact. The name/content-type
				// passed here are only used for the storage object itself, so we keep
				// them opaque (like useItemAttachments) to avoid leaking plaintext.
				const { data: upload } =
					await params.targetClient.attachments.createUpload(
						params.targetItemId,
						{
							fileName: `${globalThis.crypto?.randomUUID?.() ?? Date.now()}.enc`,
							contentType: "application/octet-stream",
							fileSize: attachment.fileSize,
						},
					);

				// Re-encrypt under the TARGET scope (target vault key + target AAD bound
				// to the freshly-minted storage key).
				const reEncrypted = await encryptAttachmentParts(
					this.vaultCrypto,
					params.targetVaultKey,
					{
						vaultId: params.targetVaultId,
						attachmentKey: upload.key,
						userId: params.targetUserId,
					},
					decrypted,
				);

				const putResponse = await fetch(upload.uploadUrl, {
					method: "PUT",
					headers: { "Content-Type": "application/octet-stream" },
					body: encodeAttachmentBlobEnvelope(reEncrypted.blobEnvelope),
				});
				if (!putResponse.ok) {
					throw new Error(
						`Failed to upload migrated attachment for item ${params.targetItemId}.`,
					);
				}

				await params.targetClient.attachments.create(
					params.targetItemId,
					{
						storageKey: upload.key,
						encryptedName: reEncrypted.encryptedName,
						encryptedContentType: reEncrypted.encryptedContentType,
						encryptionIv: reEncrypted.encryptionIv,
						encryptedContentTypeIv: reEncrypted.encryptedContentTypeIv,
						encryptionAlgorithm: reEncrypted.encryptionAlgorithm,
						fileSize: attachment.fileSize,
					},
					params.attachmentAttemptId
						? {
								idempotencyKey: `${params.attachmentAttemptId}:attachment:${attachment.id}`,
							}
						: undefined,
				);
			}
		} finally {
			await this.crypto.destroyKey(sourceVaultKey);
		}
	}

	/**
	 * Best-effort removal of a target item created during a cross-account move
	 * whose attachment migration failed. Swallows errors: the invariant we care
	 * about (the SOURCE item is never deleted on failure) is upheld by the caller,
	 * so a lingering partial target is acceptable if cleanup can't complete.
	 */
	private async bestEffortDeleteTargetItem(
		targetClient: DefaultApiClient,
		targetItemId: string,
	): Promise<void> {
		try {
			await targetClient.items.trash(targetItemId, {
				etag: strongItemEtag(1),
			});
			await targetClient.items.deletePermanently(targetItemId, {
				etag: strongItemEtag(2),
			});
		} catch (cleanupError) {
			console.error(
				"[ItemService] Failed to clean up partial target item after attachment migration failure:",
				cleanupError,
			);
		}
	}

	private sourceConflict(itemId: string): ApiError {
		return new ApiError(
			{
				type: "https://bittery.com/problems/precondition-failed",
				title: "Precondition Failed",
				status: 412,
				code: "PRECONDITION_FAILED",
				detail: `Item ${itemId} changed before its cross-account move completed`,
			},
			null,
		);
	}

	private async probeItem(
		client: DefaultApiClient,
		itemId: string,
	): Promise<Awaited<ReturnType<DefaultApiClient["items"]["get"]>> | null> {
		try {
			return await client.items.get(itemId);
		} catch (error) {
			if (isApiErrorStatus(error, 404)) return null;
			throw error;
		}
	}

	private async clearTargetAttachments(
		client: DefaultApiClient,
		itemId: string,
		operationId: string,
	): Promise<void> {
		const { data: attachments } = await client.attachments.list(itemId);
		for (const attachment of attachments ?? []) {
			try {
				await client.attachments.remove(attachment.id, {
					idempotencyKey: `${operationId}:clear-attachment:${attachment.id}`,
				});
			} catch (error) {
				if (!isApiErrorStatus(error, 404)) throw error;
			}
		}
	}

	async executeCrossAccountMoveCommand(
		command: ItemSyncCommand,
	): Promise<ItemSyncAcknowledgement | undefined> {
		if (command.type !== "cross_account_move") return undefined;
		const payload = command.encryptedPayload;
		const targetAccountId = command.targetAccountId;
		const targetVaultId = command.targetVaultId;
		const targetItemId = command.targetItemId;
		const operationId = command.operationId ?? command.id;
		if (
			!payload ||
			!command.category ||
			!targetAccountId ||
			!targetVaultId ||
			!targetItemId
		) {
			throw new Error(`Invalid cross-account move command ${operationId}`);
		}

		const [sourceClient, targetClient] = await Promise.all([
			this.accounts.getClientForAccount(
				{} as DefaultApiClient,
				command.accountId,
			),
			this.accounts.getClientForAccount(
				{} as DefaultApiClient,
				targetAccountId,
			),
		]);
		const [source, target] = await Promise.all([
			this.probeItem(sourceClient, command.entityId),
			this.probeItem(targetClient, targetItemId),
		]);
		if (
			target &&
			(target.data.vaultId !== targetVaultId ||
				target.data.category !== command.category ||
				target.data.encryptedData !== payload.encryptedData ||
				target.data.encryptionIv !== payload.encryptionIv ||
				target.data.encryptionAlgorithm !== payload.encryptionAlgorithm)
		) {
			throw new Error(
				`Deterministic target ${targetItemId} does not match move`,
			);
		}

		if (!source) {
			if (!target) {
				throw new Error(
					`Cross-account move ${operationId} lost both source and target Items`,
				);
			}
			return {
				entityId: command.entityId,
				etag: `"${command.baseVersion + 2}"`,
				version: command.baseVersion + 2,
			};
		}

		const sourceVersion = source.data.version;
		if (source.data.deletedAt) {
			if (sourceVersion !== command.baseVersion + 1 || !target) {
				throw this.sourceConflict(command.entityId);
			}
			await sourceClient.items.deletePermanently(command.entityId, {
				etag: strongItemEtag(sourceVersion),
				idempotencyKey: `${operationId}:delete-source`,
			});
			return {
				entityId: command.entityId,
				etag: `"${sourceVersion + 1}"`,
				version: sourceVersion + 1,
			};
		}
		if (sourceVersion !== command.baseVersion) {
			throw this.sourceConflict(command.entityId);
		}

		if (target) {
			await this.clearTargetAttachments(
				targetClient,
				targetItemId,
				operationId,
			);
		} else {
			await targetClient.items.create(
				targetVaultId,
				targetItemId,
				{
					category: command.category,
					encryptedData: payload.encryptedData,
					encryptionIv: payload.encryptionIv,
					encryptionAlgorithm: payload.encryptionAlgorithm,
				},
				{ idempotencyKey: `${operationId}:create-target` },
			);
		}

		const targetVaultKey = await this.getVaultKey(
			targetVaultId,
			command.targetAccountEmail ?? targetAccountId,
		);
		if (!targetVaultKey) {
			throw new Error("Cannot access target vault key for cross-account move");
		}
		try {
			await this.migrateAttachmentsForCrossAccountMove({
				sourceClient,
				targetClient,
				sourceItemId: command.entityId,
				targetItemId,
				sourceVaultId: command.vaultId,
				targetVaultId,
				sourceAccountEmail: command.accountEmail ?? command.accountId,
				targetVaultKey,
				targetUserId: await this.resolveUserId(
					command.targetAccountEmail ?? targetAccountId,
				),
				attachmentAttemptId: command.attemptId ?? command.id,
			});
		} finally {
			await this.crypto.destroyKey(targetVaultKey);
		}

		await sourceClient.items.trash(command.entityId, {
			etag: strongItemEtag(command.baseVersion),
			idempotencyKey: `${operationId}:trash-source`,
		});
		await sourceClient.items.deletePermanently(command.entityId, {
			etag: strongItemEtag(command.baseVersion + 1),
			idempotencyKey: `${operationId}:delete-source`,
		});
		return {
			entityId: command.entityId,
			etag: `"${command.baseVersion + 2}"`,
			version: command.baseVersion + 2,
		};
	}

	async moveItem(
		input: MoveItemInput,
		defaultClient: DefaultApiClient,
	): Promise<MoveItemResult> {
		const sourceAccountEmail = input.sourceAccountEmail;
		let targetAccountEmail = input.targetAccountEmail ?? sourceAccountEmail;
		const sourceAccountId = await resolveAccountScopeId(
			this.storage,
			sourceAccountEmail,
		);
		if (!sourceAccountId)
			throw new Error("Source account identity is required");

		if (!input.targetAccountEmail) {
			const sourceVaultKeys = await this.storage.getVaultKeys(sourceAccountId);
			const targetInSource = sourceVaultKeys?.some(
				(vaultKey) => vaultKey.vaultId === input.targetVaultId,
			);

			if (targetInSource) {
				targetAccountEmail = sourceAccountEmail;
			} else if (sourceAccountEmail) {
				const accounts = await this.storage.getAccountsList();
				for (const account of accounts) {
					if (account.email === sourceAccountEmail) {
						continue;
					}
					const vaultKeys = await this.storage.getVaultKeys(account.accountId);
					if (
						vaultKeys?.some(
							(vaultKey) => vaultKey.vaultId === input.targetVaultId,
						)
					) {
						targetAccountEmail = account.email;
						break;
					}
				}
			}
		}

		const isCrossAccount = sourceAccountEmail !== targetAccountEmail;
		const targetAccountId = await resolveAccountScopeId(
			this.storage,
			targetAccountEmail,
		);
		if (!targetAccountId)
			throw new Error("Target account identity is required");
		const targetVaultKey = await this.getVaultKey(
			input.targetVaultId,
			targetAccountEmail,
		);
		if (!targetVaultKey) {
			throw new Error(
				"Cannot access target vault key. Please unlock the target account.",
			);
		}
		try {
			const targetItemId = isCrossAccount
				? await this.generateItemId()
				: input.itemId;
			let targetVersion = 1;
			if (!isCrossAccount) {
				const sourceItem = await this.fetchAndDecryptItem(
					input.itemId,
					defaultClient,
					sourceAccountEmail,
				);
				targetVersion = (sourceItem.rawItem?.version ?? 1) + 1;
			}

			const targetUserId = await this.resolveUserId(targetAccountEmail);
			const context: ItemWriteScope = {
				vaultId: input.targetVaultId,
				itemId: targetItemId,
				version: targetVersion,
				userId: targetUserId,
			};

			const encryptedData = await this.vaultCrypto.encryptItem(
				JSON.stringify(input.decryptedData),
				targetVaultKey,
				context,
			);

			if (isCrossAccount) {
				const targetClient = await this.accounts.getClientForAccount(
					defaultClient,
					targetAccountId,
				);
				const { data: createResult } = await targetClient.items.create(
					input.targetVaultId,
					targetItemId,
					{
						category: input.category,
						encryptedData: encryptedData.ciphertext,
						encryptionIv: encryptedData.iv,
						encryptionAlgorithm: encryptedData.algorithm,
					},
				);

				const fallbackId =
					createResult.id && createResult.id !== input.targetVaultId
						? createResult.id
						: undefined;
				const newItemId = createResult.itemId ?? fallbackId;
				if (!newItemId) {
					throw new Error("Failed to create item in target account");
				}
				if (newItemId !== targetItemId) {
					throw new Error("Server returned mismatched item ID");
				}

				const sourceClient = await this.accounts.getClientForAccount(
					defaultClient,
					sourceAccountId,
				);

				// Migrate attachment blobs onto the newly-created target item BEFORE the
				// source item is deleted. Attachment ciphertext cannot be copied as-is:
				// the vault key, and the AAD's vaultId/userId/attachmentKey all differ on
				// the target, so every attachment is downloaded, decrypted under the
				// source scope and re-encrypted + re-uploaded under a fresh, server-minted
				// target storage key.
				//
				// Partial-failure policy: the move is already non-atomic, so we optimise
				// for NEVER losing data. If any attachment step throws (including target
				// quota errors from createAttachmentUpload) we do NOT delete the source —
				// its item and attachments stay intact for a retry — and we best-effort
				// remove the partially-created target item so no orphan/duplicate lingers.
				try {
					await this.migrateAttachmentsForCrossAccountMove({
						sourceClient,
						targetClient,
						sourceItemId: input.itemId,
						targetItemId,
						sourceVaultId: input.sourceVaultId,
						targetVaultId: input.targetVaultId,
						sourceAccountEmail,
						targetVaultKey,
						targetUserId,
					});
				} catch (error) {
					await this.bestEffortDeleteTargetItem(targetClient, targetItemId);
					throw error instanceof Error
						? error
						: new Error(
								"Failed to migrate attachments during cross-account move. The original item was left intact.",
							);
				}

				try {
					const sourceVersion = (await sourceClient.items.get(input.itemId))
						.data.version;
					await sourceClient.items.trash(input.itemId, {
						etag: strongItemEtag(sourceVersion),
					});
					await sourceClient.items.deletePermanently(input.itemId, {
						etag: strongItemEtag(sourceVersion + 1),
					});
				} catch (error) {
					console.error(
						"[ItemService] Failed to delete source item after cross-account move:",
						error,
					);
					throw new Error(
						"Item created in target account but failed to delete from source. Please delete the original item manually.",
					);
				}

				return {
					crossAccount: true,
					newItemId,
					_encryptedData: encryptedData,
					_sourceAccountEmail: sourceAccountEmail,
					_targetAccountEmail: targetAccountEmail,
				};
			}

			const sourceClient = await this.accounts.getClientForAccount(
				defaultClient,
				sourceAccountId,
			);
			await sourceClient.items.move(
				input.itemId,
				{
					sourceVaultId: input.sourceVaultId,
					targetVaultId: input.targetVaultId,
					encryptedData: encryptedData.ciphertext,
					encryptionIv: encryptedData.iv,
					encryptionAlgorithm: encryptedData.algorithm,
				},
				{ etag: strongItemEtag(targetVersion - 1) },
			);

			return {
				crossAccount: false,
				_encryptedData: encryptedData,
				_sourceAccountEmail: sourceAccountEmail,
				_targetAccountEmail: targetAccountEmail,
			};
		} finally {
			await this.crypto.destroyKey(targetVaultKey);
		}
	}
}
