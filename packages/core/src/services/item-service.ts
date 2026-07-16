import {
	getDecryptedVaultKey as getDecryptedVaultKeyUtil,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { applyPasswordHistoryOnPasswordChange } from "@bittery/shared/password-history";
import type {
	DecryptedItem,
	DecryptedItemData,
	ItemCategory,
} from "@bittery/shared/types";
import {
	resolveAccountScopeId,
	resolveUserIdForScope,
} from "@bittery/storage/account-id";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedVaultMetadata,
	ICrypto,
	RawEncryptedItem,
	RawEncryptedItemWithVault,
} from "@bittery/types";
import type {
	AccountInfo,
	AccountResolver,
	DefaultRpcClient,
} from "./account-resolver";
import {
	decryptAttachmentParts,
	encodeAttachmentBlobEnvelope,
	encryptAttachmentParts,
	parseAttachmentBlobEnvelope,
} from "./attachment-crypto";
import { buildItemEncryptionContext } from "./encryption-context";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";

export type { RawEncryptedItem, RawEncryptedItemWithVault };

export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

export interface RawEncryptedItemWithVersion extends RawEncryptedItem {
	version: number;
	lastModifiedBy: string | null;
	attachments?: CachedAttachment[];
}

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

type DecryptableItemRecord = {
	id: string;
	vaultId: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	version?: number;
	lastModifiedBy?: string | null;
};

type RpcVaultSummary = {
	id: string;
	name: string;
	vaultType: string;
	icon: string | null;
	imageUrl: string | null;
} | null;

function normalizeVaultSummary(
	vault: RpcVaultSummary,
	vaultId: string,
): RawEncryptedItemWithVault["vault"] {
	return {
		id: vault?.id ?? vaultId,
		name: vault?.name ?? "Unknown Vault",
		type: vault?.vaultType ?? "personal",
		icon: vault?.icon ?? null,
		imageUrl: vault?.imageUrl ?? null,
	};
}

function normalizeRawItemWithVault<
	TItem extends RawEncryptedItem & {
		vault: RpcVaultSummary;
	},
>(item: TItem): RawEncryptedItemWithVault {
	return {
		...item,
		vault: normalizeVaultSummary(item.vault, item.vaultId),
	};
}

interface ItemServiceDeps {
	storage: IStorageAdapter;
	crypto: ICrypto;
	accounts: AccountResolver;
}

export class ItemService {
	private readonly storage: IStorageAdapter;
	private readonly crypto: ICrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: ItemServiceDeps) {
		this.storage = deps.storage;
		this.crypto = deps.crypto;
		this.accounts = deps.accounts;
	}

	async generateItemId(): Promise<string> {
		if (this.crypto.generateUuid) {
			return await this.crypto.generateUuid();
		}
		const random = globalThis?.crypto?.randomUUID?.();
		if (random) {
			return random;
		}
		return `item_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
	}

	private async resolveUserId(scope?: string): Promise<string> {
		return resolveUserIdForScope(this.storage, scope);
	}

	async encryptItemData(
		data: DecryptedItemData,
		vaultKey: Uint8Array,
		context?: Parameters<ICrypto["encrypt"]>[2],
	): Promise<EncryptedPayload> {
		return this.crypto.encrypt(JSON.stringify(data), vaultKey, context);
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

	private getVersionCandidates(version?: number): number[] {
		const normalized =
			typeof version === "number" && Number.isFinite(version) && version > 0
				? Math.floor(version)
				: 1;
		const candidates: number[] = [];
		for (let candidate = normalized; candidate >= 1; candidate -= 1) {
			candidates.push(candidate);
		}
		return candidates;
	}

	private async decryptItemPayload(
		item: DecryptableItemRecord,
		vaultKey: Uint8Array,
		fallbackUserId: string,
	): Promise<string> {
		const storedVersion =
			typeof item.version === "number" && Number.isFinite(item.version)
				? Math.floor(item.version)
				: 1;
		const userId = item.lastModifiedBy ?? fallbackUserId;
		let lastError: unknown = null;

		for (const version of this.getVersionCandidates(storedVersion)) {
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

				if (version !== storedVersion) {
					console.warn(
						`[ItemService] Recovered item ${item.id} with fallback encryption version ${version} (stored version ${storedVersion})`,
					);
				}

				return decrypted;
			} catch (error) {
				lastError = error;
			}
		}

		throw lastError ?? new Error(`Failed to decrypt item ${item.id}`);
	}

	async reEncryptForVault(
		data: DecryptedItemData,
		targetVaultKey: Uint8Array,
		context?: Parameters<ICrypto["encrypt"]>[2],
	): Promise<EncryptedPayload> {
		return this.crypto.encrypt(JSON.stringify(data), targetVaultKey, context);
	}

	private async getVaultKey(
		vaultId: string,
		scope?: string,
	): Promise<Uint8Array | null> {
		const accountId = await resolveAccountScopeId(this.storage, scope);
		return getDecryptedVaultKeyUtil({
			vaultId,
			accountId,
			storage: this.storage,
			crypto: this.crypto as unknown as VaultKeyCryptoProvider,
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
			.map((item) => {
				const vault = vaultMap.get(item.vaultId);
				return {
					id: item.id,
					vaultId: item.vaultId,
					category: item.category,
					favorite: item.favorite,
					encryptedData: item.encryptedData,
					encryptionIv: item.encryptionIv,
					encryptionAlgorithm: item.encryptionAlgorithm,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
					deletedAt: item.deletedAt,
					attachments: item.attachments,
					vault: vault
						? {
								id: vault.id,
								name: vault.name,
								type: vault.type,
								icon: vault.icon,
								imageUrl: vault.imageUrl,
							}
						: {
								id: item.vaultId,
								name: "Unknown",
								type: "personal",
								icon: null,
								imageUrl: null,
							},
				};
			});
	}

	private toCachedItems(
		rawItems: RawEncryptedItemWithVault[],
		account: Pick<AccountInfo, "email" | "serverUrl">,
	): CachedEncryptedItem[] {
		return rawItems.map((item) => ({
			id: item.id,
			vaultId: item.vaultId,
			accountEmail: account.email,
			serverUrl: account.serverUrl,
			category: item.category,
			favorite: item.favorite,
			encryptedData: item.encryptedData,
			encryptionIv: item.encryptionIv,
			encryptionAlgorithm: item.encryptionAlgorithm,
			version: (item as { version?: number }).version ?? 1,
			lastModifiedBy:
				(item as { lastModifiedBy?: string | null }).lastModifiedBy ?? null,
			createdAt: String(item.createdAt),
			updatedAt: String(item.updatedAt),
			deletedAt: item.deletedAt ? String(item.deletedAt) : null,
			attachments: item.attachments?.map((a) => ({
				...a,
				createdAt: String(a.createdAt),
			})),
		}));
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
		client: DefaultRpcClient,
	): Promise<RawEncryptedItemWithVault[]> {
		const allItems: RawEncryptedItemWithVault[] = [];
		let cursor: string | null = null;

		while (true) {
			const page = await client.sync.bootstrapItems.query({
				cursor,
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
						this.storage.getCachedItems?.(account.accountId),
						this.storage.getCachedVaults?.(account.accountId),
					]);

					if (cachedItems && cachedVaults && cachedItems.length > 0) {
						rawItems = this.buildRawItemsFromCache(
							cachedItems,
							cachedVaults,
							false,
						);
					} else {
						rawItems = await this.fetchBootstrapItems(account.rpcClient);
						const cachedItems = this.toCachedItems(rawItems, account);
						const cachedVaults = this.toCachedVaults(rawItems, account);
						await Promise.all([
							this.storage.setCachedItems?.(cachedItems, account.accountId),
							this.storage.setCachedVaults?.(cachedVaults, account.accountId),
							this.storage.setItemCacheMetadata?.(
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
					const enforcer = getTravelModeEnforcer(this.storage);
					enforcer.assertVerified(account.accountId);
					rawItems = enforcer.filterItems(account.accountId, rawItems);

					const vaultKeyCache = new Map<string, Uint8Array>();
					const decrypted = await Promise.all(
						rawItems.map(async (rawItem): Promise<MultiAccountItem | null> => {
							try {
								let vaultKey = vaultKeyCache.get(rawItem.vaultId);
								if (!vaultKey) {
									const fetchedKey = await this.getVaultKey(
										rawItem.vaultId,
										account.accountId,
									);
									if (fetchedKey) {
										vaultKey = fetchedKey;
										vaultKeyCache.set(rawItem.vaultId, fetchedKey);
									}
								}

								if (!vaultKey) {
									throw new Error(`No vault key for vault ${rawItem.vaultId}`);
								}

								const decryptedData = await this.decryptItemPayload(
									rawItem,
									vaultKey,
									account.userId,
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
									vault: {
										id: rawItem.vault.id,
										name: rawItem.vault.name,
										type: rawItem.vault.type,
										icon: rawItem.vault.icon,
										imageUrl: rawItem.vault.imageUrl,
									},
								} as MultiAccountItem;
							} catch (error) {
								console.error(
									`[ItemService] Failed to decrypt item ${rawItem.id} for ${account.email}:`,
									error,
								);
								return null;
							}
						}),
					);

					return decrypted.filter(
						(item): item is MultiAccountItem => item !== null,
					);
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
		const cachedItems = await this.storage.getCachedItems?.(
			ownerAccount.accountId,
		);
		if (cachedItems && cachedItems.length > 0) {
			const vaultItems = cachedItems.filter(
				(item) => item.vaultId === vaultId && !item.deletedAt,
			);
			if (vaultItems.length > 0) {
				rawItems = vaultItems.map((item) => ({
					id: item.id,
					vaultId: item.vaultId,
					category: item.category,
					favorite: item.favorite,
					encryptedData: item.encryptedData,
					encryptionIv: item.encryptionIv,
					encryptionAlgorithm: item.encryptionAlgorithm,
					version: item.version,
					lastModifiedBy: item.lastModifiedBy,
					createdAt: item.createdAt,
					updatedAt: item.updatedAt,
				}));
			} else {
				rawItems = await ownerAccount.rpcClient.vault.listItems.query({
					vaultId,
				});
			}
		} else {
			rawItems = await ownerAccount.rpcClient.vault.listItems.query({
				vaultId,
			});
		}

		// Fail-closed travel-mode guard: require a verified policy for the owning
		// account and drop items in hidden vaults (a hidden target vault yields no
		// items) before decrypting, mirroring VaultRepository.
		const enforcer = getTravelModeEnforcer(this.storage);
		enforcer.assertVerified(ownerAccount.accountId);
		rawItems = enforcer.filterItems(ownerAccount.accountId, rawItems);

		if (rawItems.length === 0) {
			return [];
		}

		const vaultKey = await this.getVaultKey(vaultId, ownerAccount.accountId);
		if (!vaultKey) {
			throw new Error(`No vault key found for vault ${vaultId}`);
		}

		const decryptedItems = await Promise.all(
			rawItems.map(async (item) => {
				try {
					const decryptedData = await this.decryptItemPayload(
						item,
						vaultKey,
						ownerAccount.userId,
					);

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
	}

	async fetchAndDecryptItem(
		itemId: string,
		defaultClient: DefaultRpcClient,
		accountEmail?: string,
	): Promise<FetchDecryptedItemResult> {
		if (!itemId) {
			return { rawItem: null, decryptedData: null };
		}

		let rawItem: RawEncryptedItemWithVersion | null = null;

		const accountId = await resolveAccountScopeId(this.storage, accountEmail);
		const cachedItems = await this.storage.getCachedItems?.(accountId);
		const cached = cachedItems?.find((item) => item.id === itemId);
		if (cached) {
			rawItem = {
				id: cached.id,
				vaultId: cached.vaultId,
				category: cached.category,
				favorite: cached.favorite,
				encryptedData: cached.encryptedData,
				encryptionIv: cached.encryptionIv,
				encryptionAlgorithm: cached.encryptionAlgorithm,
				version: cached.version,
				lastModifiedBy: cached.lastModifiedBy,
				createdAt: cached.createdAt,
				updatedAt: cached.updatedAt,
				deletedAt: cached.deletedAt ?? null,
				attachments: cached.attachments,
			};
		}

		if (!rawItem) {
			if (!accountId) throw new Error("Account identity is required");
			const client = await this.accounts.getClientForAccount(
				defaultClient,
				accountId,
			);
			const fetched = await client.vault.getItem.query({ itemId });
			rawItem = {
				id: fetched.id,
				vaultId: fetched.vaultId,
				category: fetched.category,
				favorite: fetched.favorite,
				encryptedData: fetched.encryptedData,
				encryptionIv: fetched.encryptionIv,
				encryptionAlgorithm: fetched.encryptionAlgorithm,
				version: fetched.version,
				lastModifiedBy: fetched.lastModifiedBy,
				createdAt: fetched.createdAt,
				updatedAt: fetched.updatedAt,
				deletedAt: fetched.deletedAt,
				attachments: (fetched as any).attachments?.map((a: any) => ({
					...a,
					createdAt: String(a.createdAt),
				})),
			};
		}

		const vaultKey = await this.getVaultKey(rawItem.vaultId, accountEmail);

		if (!vaultKey) {
			throw new Error(
				`No vault key found for decryption${accountEmail ? ` (account: ${accountEmail})` : ""}`,
			);
		}

		const decryptedJson = await this.decryptItemPayload(
			rawItem,
			vaultKey,
			await this.resolveUserId(accountEmail),
		);

		return {
			rawItem,
			decryptedData: JSON.parse(decryptedJson) as DecryptedItemData,
		};
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
						this.storage.getCachedItems?.(account.accountId),
						this.storage.getCachedVaults?.(account.accountId),
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
							rawItems = (
								await account.rpcClient.vault.listAllDeletedItems.query()
							).map((item) => normalizeRawItemWithVault(item));
						}
					} else {
						rawItems = (
							await account.rpcClient.vault.listAllDeletedItems.query()
						).map((item) => normalizeRawItemWithVault(item));
					}

					// Fail-closed travel-mode guard: require a verified policy and
					// drop items in hidden vaults before decrypting, mirroring
					// VaultRepository, so deleted-item listings can't leak
					// hidden-vault data if wired into a UI later.
					const enforcer = getTravelModeEnforcer(this.storage);
					enforcer.assertVerified(account.accountId);
					rawItems = enforcer.filterItems(account.accountId, rawItems);

					const vaultKeyCache = new Map<string, Uint8Array>();
					const decrypted = await Promise.all(
						rawItems.map(
							async (rawItem): Promise<MultiAccountDeletedItem | null> => {
								try {
									let vaultKey = vaultKeyCache.get(rawItem.vaultId);
									if (!vaultKey) {
										const fetchedKey = await this.getVaultKey(
											rawItem.vaultId,
											account.accountId,
										);
										if (fetchedKey) {
											vaultKey = fetchedKey;
											vaultKeyCache.set(rawItem.vaultId, fetchedKey);
										}
									}

									if (!vaultKey) {
										throw new Error(
											`No vault key for vault ${rawItem.vaultId}`,
										);
									}

									const decryptedData = await this.decryptItemPayload(
										rawItem,
										vaultKey,
										account.userId,
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
										vault: {
											id: rawItem.vault.id,
											name: rawItem.vault.name,
											type: rawItem.vault.type,
											icon: rawItem.vault.icon,
											imageUrl: rawItem.vault.imageUrl,
										},
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
		defaultClient: DefaultRpcClient,
	): Promise<CreateItemResult> {
		const vaultKey = await this.getVaultKey(input.vaultId, input.accountEmail);
		if (!vaultKey) {
			throw new Error("No vault key found. Please sign in again.");
		}

		const itemId = await this.generateItemId();
		const userId = await this.resolveUserId(input.accountEmail);
		const context = buildItemEncryptionContext({
			vaultId: input.vaultId,
			itemId,
			version: 1,
			userId,
		});

		const encryptedData = await this.crypto.encrypt(
			JSON.stringify(input.data),
			vaultKey,
			context,
		);

		const accountId = await resolveAccountScopeId(
			this.storage,
			input.accountEmail,
		);
		if (!accountId) throw new Error("Account identity is required");
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);

		const result = (await client.vault.createItem.mutate({
			itemId,
			vaultId: input.vaultId,
			category: input.category,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
			clientId: null,
		})) as { itemId?: string; id?: string };

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
	}

	async updateItem(
		input: UpdateItemInput,
		defaultClient: DefaultRpcClient,
	): Promise<UpdateItemResult> {
		const vaultKey = await this.getVaultKey(input.vaultId, input.accountEmail);
		if (!vaultKey) {
			throw new Error("No vault key found. Please sign in again.");
		}

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
		const context = buildItemEncryptionContext({
			vaultId: input.vaultId,
			itemId: input.itemId,
			version: nextVersion,
			userId,
		});

		const encryptedData = await this.crypto.encrypt(
			JSON.stringify(encryptedPayload),
			vaultKey,
			context,
		);

		const accountId = await resolveAccountScopeId(
			this.storage,
			input.accountEmail,
		);
		if (!accountId) throw new Error("Account identity is required");
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);

		await client.vault.updateItem.mutate({
			itemId: input.itemId,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
			expectedVersion: rawItem?.version ?? null,
			clientId: null,
		});

		return { _encryptedData: encryptedData, _accountEmail: input.accountEmail };
	}

	/**
	 * Copy every attachment from the source item onto the target item during a
	 * cross-account move. Throws on the first failure so the caller can keep the
	 * source intact. No-op (and no source vault-key lookup) when the item has no
	 * attachments.
	 */
	private async migrateAttachmentsForCrossAccountMove(params: {
		sourceClient: DefaultRpcClient;
		targetClient: DefaultRpcClient;
		sourceItemId: string;
		targetItemId: string;
		sourceVaultId: string;
		targetVaultId: string;
		sourceAccountEmail?: string;
		targetVaultKey: Uint8Array;
		targetUserId: string;
	}): Promise<void> {
		const attachments = await params.sourceClient.vault.listAttachments.query({
			itemId: params.sourceItemId,
		});
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
		const sourceUserId = await this.resolveUserId(params.sourceAccountEmail);

		for (const attachment of attachments) {
			// Fetch the encrypted blob envelope from object storage.
			const download =
				await params.sourceClient.vault.getAttachmentDownloadUrl.mutate({
					attachmentId: attachment.id,
				});
			const response = await fetch(download.downloadUrl);
			if (!response.ok) {
				throw new Error(
					`Failed to download attachment ${attachment.id} during cross-account move.`,
				);
			}
			const blobEnvelope = parseAttachmentBlobEnvelope(await response.text());

			// Decrypt under the SOURCE scope (source vault key + source AAD). The
			// attachment's own uploader is used for context binding when present,
			// mirroring the read paths in useItemAttachments.
			const decrypted = await decryptAttachmentParts(
				this.crypto,
				sourceVaultKey,
				{
					vaultId: params.sourceVaultId,
					attachmentKey: attachment.storageKey,
					userId: attachment.uploadedBy || sourceUserId,
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
			const upload =
				await params.targetClient.vault.createAttachmentUpload.mutate({
					itemId: params.targetItemId,
					fileName: `${globalThis.crypto?.randomUUID?.() ?? Date.now()}.enc`,
					contentType: "application/octet-stream",
					fileSize: attachment.fileSize,
				});

			// Re-encrypt under the TARGET scope (target vault key + target AAD bound
			// to the freshly-minted storage key).
			const reEncrypted = await encryptAttachmentParts(
				this.crypto,
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

			await params.targetClient.vault.createAttachment.mutate({
				itemId: params.targetItemId,
				storageKey: upload.key,
				encryptedName: reEncrypted.encryptedName,
				encryptedContentType: reEncrypted.encryptedContentType,
				encryptionIv: reEncrypted.encryptionIv,
				encryptedContentTypeIv: reEncrypted.encryptedContentTypeIv,
				encryptionAlgorithm: reEncrypted.encryptionAlgorithm,
				fileSize: attachment.fileSize,
			});
		}
	}

	/**
	 * Best-effort removal of a target item created during a cross-account move
	 * whose attachment migration failed. Swallows errors: the invariant we care
	 * about (the SOURCE item is never deleted on failure) is upheld by the caller,
	 * so a lingering partial target is acceptable if cleanup can't complete.
	 */
	private async bestEffortDeleteTargetItem(
		targetClient: DefaultRpcClient,
		targetItemId: string,
	): Promise<void> {
		try {
			await targetClient.vault.deleteItem.mutate({
				itemId: targetItemId,
				clientId: null,
			});
			await targetClient.vault.permanentlyDeleteItem.mutate({
				itemId: targetItemId,
				clientId: null,
			});
		} catch (cleanupError) {
			console.error(
				"[ItemService] Failed to clean up partial target item after attachment migration failure:",
				cleanupError,
			);
		}
	}

	async moveItem(
		input: MoveItemInput,
		defaultClient: DefaultRpcClient,
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
		const context = buildItemEncryptionContext({
			vaultId: input.targetVaultId,
			itemId: targetItemId,
			version: targetVersion,
			userId: targetUserId,
		});

		const encryptedData = await this.crypto.encrypt(
			JSON.stringify(input.decryptedData),
			targetVaultKey,
			context,
		);

		if (isCrossAccount) {
			const targetClient = await this.accounts.getClientForAccount(
				defaultClient,
				targetAccountId,
			);
			const createResult = (await targetClient.vault.createItem.mutate({
				itemId: targetItemId,
				vaultId: input.targetVaultId,
				category: input.category,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
				clientId: null,
			})) as {
				itemId?: string;
				id?: string;
			};

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
				await sourceClient.vault.deleteItem.mutate({
					itemId: input.itemId,
					clientId: null,
				});
				await sourceClient.vault.permanentlyDeleteItem.mutate({
					itemId: input.itemId,
					clientId: null,
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
		await sourceClient.vault.moveItem.mutate({
			itemId: input.itemId,
			sourceVaultId: input.sourceVaultId,
			targetVaultId: input.targetVaultId,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
			clientId: null,
		});

		return {
			crossAccount: false,
			_encryptedData: encryptedData,
			_sourceAccountEmail: sourceAccountEmail,
			_targetAccountEmail: targetAccountEmail,
		};
	}
}
