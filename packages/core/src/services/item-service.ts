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
	DefaultTrpcClient,
} from "./account-resolver";
import { buildItemEncryptionContext } from "./encryption-context";

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
	account?: {
		email: string;
		userId: string;
		name: string;
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
	account?: {
		email: string;
		userId: string;
		name: string;
	};
	[key: string]: any;
}

export interface FetchItemsOptions {
	isAllAccountsMode?: boolean;
}

export interface FetchDeletedItemsOptions {
	isAllAccountsMode?: boolean;
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

	private async resolveUserId(email?: string): Promise<string> {
		const sessionUserId = await this.storage.getStoredSessionData?.(email);
		if (sessionUserId?.userId) {
			return sessionUserId.userId;
		}

		const activeUserId = await this.storage.getActiveAccountUserId();
		if (activeUserId) {
			return activeUserId;
		}

		throw new Error("User ID not available for encryption context");
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

	async reEncryptForVault(
		data: DecryptedItemData,
		targetVaultKey: Uint8Array,
		context?: Parameters<ICrypto["encrypt"]>[2],
	): Promise<EncryptedPayload> {
		return this.crypto.encrypt(JSON.stringify(data), targetVaultKey, context);
	}

	private async getVaultKey(
		vaultId: string,
		email?: string,
	): Promise<Uint8Array | null> {
		return getDecryptedVaultKeyUtil({
			vaultId,
			email,
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
	): CachedEncryptedItem[] {
		return rawItems.map((item) => ({
			id: item.id,
			vaultId: item.vaultId,
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
				name: item.vault.name,
				type: item.vault.type,
				icon: item.vault.icon,
				imageUrl: item.vault.imageUrl,
			});
		}

		return vaults;
	}

	private async fetchBootstrapItems(
		client: DefaultTrpcClient,
	): Promise<RawEncryptedItemWithVault[]> {
		const allItems: RawEncryptedItemWithVault[] = [];
		let cursor: string | undefined;

		while (true) {
			const page = await client.sync.bootstrapItems.query({
				cursor,
				limit: 500,
			});

			allItems.push(...(page.items as RawEncryptedItemWithVault[]));
			if (!page.hasMore || !page.nextCursor) {
				break;
			}

			cursor = page.nextCursor;
		}

		return allItems;
	}

	async fetchAndDecryptItems(
		accounts: AccountInfo[],
		options: FetchItemsOptions = {},
	): Promise<MultiAccountItem[]> {
		if (accounts.length === 0) return [];

		const results = await Promise.all(
			accounts.map(async (account) => {
				try {
					let rawItems: RawEncryptedItemWithVault[];

					const [cachedItems, cachedVaults] = await Promise.all([
						this.storage.getCachedItems?.(account.email),
						this.storage.getCachedVaults?.(account.email),
					]);

					if (cachedItems && cachedVaults && cachedItems.length > 0) {
						rawItems = this.buildRawItemsFromCache(
							cachedItems,
							cachedVaults,
							false,
						);
					} else {
						rawItems = await this.fetchBootstrapItems(account.trpcClient);
						const cachedItems = this.toCachedItems(rawItems);
						const cachedVaults = this.toCachedVaults(rawItems);
						await Promise.all([
							this.storage.setCachedItems?.(cachedItems, account.email),
							this.storage.setCachedVaults?.(cachedVaults, account.email),
							this.storage.setItemCacheMetadata?.(
								{
									lastFullSyncAt: Date.now(),
									itemCount: cachedItems.length,
									cacheVersion: 1,
								},
								account.email,
							),
						]);
					}

					const vaultKeyCache = new Map<string, Uint8Array>();
					const decrypted = await Promise.all(
						rawItems.map(async (rawItem): Promise<MultiAccountItem | null> => {
							try {
								let vaultKey = vaultKeyCache.get(rawItem.vaultId);
								if (!vaultKey) {
									const fetchedKey = await this.getVaultKey(
										rawItem.vaultId,
										account.email,
									);
									if (fetchedKey) {
										vaultKey = fetchedKey;
										vaultKeyCache.set(rawItem.vaultId, fetchedKey);
									}
								}

								if (!vaultKey) {
									throw new Error(`No vault key for vault ${rawItem.vaultId}`);
								}

								const context = buildItemEncryptionContext({
									vaultId: rawItem.vaultId,
									itemId: rawItem.id,
									version: (rawItem as { version?: number }).version ?? 1,
									userId: rawItem.lastModifiedBy ?? account.userId,
								});

								const decryptedData = await this.crypto.decrypt(
									{
										ciphertext: rawItem.encryptedData,
										iv: rawItem.encryptionIv,
										algorithm: rawItem.encryptionAlgorithm,
									},
									vaultKey,
									context,
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
									...(options.isAllAccountsMode
										? {
												account: {
													email: account.email,
													userId: account.userId,
													name: account.name,
												},
											}
										: {}),
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
			const vaultKeys = await this.storage.getVaultKeys(account.email);
			if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === vaultId)) {
				ownerAccount = account;
				break;
			}
		}

		if (!ownerAccount) {
			throw new Error(`No account found with access to vault ${vaultId}`);
		}

		let rawItems: RawEncryptedItem[];
		const cachedItems = await this.storage.getCachedItems?.(ownerAccount.email);
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
				rawItems = await ownerAccount.trpcClient.vault.listItems.query({
					vaultId,
				});
			}
		} else {
			rawItems = await ownerAccount.trpcClient.vault.listItems.query({
				vaultId,
			});
		}

		if (rawItems.length === 0) {
			return [];
		}

		const vaultKey = await this.getVaultKey(vaultId, ownerAccount.email);
		if (!vaultKey) {
			throw new Error(`No vault key found for vault ${vaultId}`);
		}

		const decryptedItems = await Promise.all(
			rawItems.map(async (item) => {
				try {
					const context = buildItemEncryptionContext({
						vaultId: item.vaultId,
						itemId: item.id,
						version: (item as { version?: number }).version ?? 1,
						userId:
							(item as { lastModifiedBy?: string | null }).lastModifiedBy ??
							ownerAccount.userId,
					});

					const decryptedData = await this.crypto.decrypt(
						{
							ciphertext: item.encryptedData,
							iv: item.encryptionIv,
							algorithm: item.encryptionAlgorithm,
						},
						vaultKey,
						context,
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
		defaultClient: DefaultTrpcClient,
		accountEmail?: string,
	): Promise<FetchDecryptedItemResult> {
		if (!itemId) {
			return { rawItem: null, decryptedData: null };
		}

		let rawItem: RawEncryptedItemWithVersion | null = null;

		const cachedItems = await this.storage.getCachedItems?.(accountEmail);
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
			const client = await this.accounts.getClientForAccount(
				defaultClient,
				accountEmail,
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

		const userId = rawItem.lastModifiedBy
			? rawItem.lastModifiedBy
			: await this.resolveUserId(accountEmail);
		const context = buildItemEncryptionContext({
			vaultId: rawItem.vaultId,
			itemId: rawItem.id,
			version: rawItem.version ?? 1,
			userId,
		});

		const decryptedJson = await this.crypto.decrypt(
			{
				ciphertext: rawItem.encryptedData,
				iv: rawItem.encryptionIv,
				algorithm: rawItem.encryptionAlgorithm,
			},
			vaultKey,
			context,
		);

		return {
			rawItem,
			decryptedData: JSON.parse(decryptedJson) as DecryptedItemData,
		};
	}

	async fetchDeletedItems(
		accounts: AccountInfo[],
		options: FetchDeletedItemsOptions = {},
	): Promise<MultiAccountDeletedItem[]> {
		if (accounts.length === 0) return [];

		const results = await Promise.all(
			accounts.map(async (account) => {
				try {
					let rawItems: RawEncryptedItemWithVault[];

					const [cachedItems, cachedVaults] = await Promise.all([
						this.storage.getCachedItems?.(account.email),
						this.storage.getCachedVaults?.(account.email),
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
							rawItems =
								await account.trpcClient.vault.listAllDeletedItems.query();
						}
					} else {
						rawItems =
							await account.trpcClient.vault.listAllDeletedItems.query();
					}

					const vaultKeyCache = new Map<string, Uint8Array>();
					const decrypted = await Promise.all(
						rawItems.map(
							async (rawItem): Promise<MultiAccountDeletedItem | null> => {
								try {
									let vaultKey = vaultKeyCache.get(rawItem.vaultId);
									if (!vaultKey) {
										const fetchedKey = await this.getVaultKey(
											rawItem.vaultId,
											account.email,
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

									const context = buildItemEncryptionContext({
										vaultId: rawItem.vaultId,
										itemId: rawItem.id,
										version:
											(rawItem as { version?: number }).version ?? 1,
										userId:
											(rawItem as { lastModifiedBy?: string | null })
												.lastModifiedBy ?? account.userId,
									});

									const decryptedData = await this.crypto.decrypt(
										{
											ciphertext: rawItem.encryptedData,
											iv: rawItem.encryptionIv,
											algorithm: rawItem.encryptionAlgorithm,
										},
										vaultKey,
										context,
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
										...(options.isAllAccountsMode
											? {
													account: {
														email: account.email,
														userId: account.userId,
														name: account.name,
													},
												}
											: {}),
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
		defaultClient: DefaultTrpcClient,
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

		const client = await this.accounts.getClientForAccount(
			defaultClient,
			input.accountEmail,
		);

		const result = (await client.vault.createItem.mutate({
			itemId,
			vaultId: input.vaultId,
			category: input.category,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
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
		defaultClient: DefaultTrpcClient,
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

		const client = await this.accounts.getClientForAccount(
			defaultClient,
			input.accountEmail,
		);

		await client.vault.updateItem.mutate({
			itemId: input.itemId,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
		});

		return { _encryptedData: encryptedData, _accountEmail: input.accountEmail };
	}

	async moveItem(
		input: MoveItemInput,
		defaultClient: DefaultTrpcClient,
	): Promise<MoveItemResult> {
		const sourceAccountEmail = input.sourceAccountEmail;
		let targetAccountEmail = input.targetAccountEmail ?? sourceAccountEmail;

		if (!input.targetAccountEmail) {
			const sourceVaultKeys =
				await this.storage.getVaultKeys(sourceAccountEmail);
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
					const vaultKeys = await this.storage.getVaultKeys(account.email);
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
				targetAccountEmail,
			);
			const createResult = (await targetClient.vault.createItem.mutate({
				itemId: targetItemId,
				vaultId: input.targetVaultId,
				category: input.category,
				encryptedData: encryptedData.ciphertext,
				encryptionIv: encryptedData.iv,
				encryptionAlgorithm: encryptedData.algorithm,
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

			try {
				const sourceClient = await this.accounts.getClientForAccount(
					defaultClient,
					sourceAccountEmail,
				);
				await sourceClient.vault.deleteItem.mutate({ itemId: input.itemId });
				await sourceClient.vault.permanentlyDeleteItem.mutate({
					itemId: input.itemId,
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
			sourceAccountEmail,
		);
		await sourceClient.vault.moveItem.mutate({
			itemId: input.itemId,
			sourceVaultId: input.sourceVaultId,
			targetVaultId: input.targetVaultId,
			encryptedData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptionAlgorithm: encryptedData.algorithm,
		});

		return {
			crossAccount: false,
			_encryptedData: encryptedData,
			_sourceAccountEmail: sourceAccountEmail,
			_targetAccountEmail: targetAccountEmail,
		};
	}
}
