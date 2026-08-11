import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import type { CachedEncryptedItem, ItemSyncCommand } from "@bittery/types";
import { core } from "./core-instance";
import { enqueueOutboundCommand } from "./outbound-drain";
import { syncCacheService } from "./services/sync-cache-service";

interface RepositoryItem extends Record<string, unknown> {
	id: string;
	vaultId: string;
	category: ItemCategory;
	version: number;
	accountEmail?: string;
}

interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
	encryptionVersion?: number;
	encryptedByUserId?: string;
}

interface ExtensionItemMutationRepository {
	getById(itemId: string): RepositoryItem | undefined;
	encryptWithVaultKey(
		vaultId: string,
		data: DecryptedItemData,
		options: { itemId?: string; version?: number; userId?: string },
	): Promise<EncryptedPayload>;
}

interface ExtensionItemMutationDeps {
	generateItemId(): Promise<string>;
	mergeItemUpdate(
		existing: DecryptedItemData,
		update: Partial<DecryptedItemData>,
		category: ItemCategory,
	): DecryptedItemData;
	resolveAccountIdByEmail(email: string): string | undefined;
	getRepositoryForAccount(accountId: string): ExtensionItemMutationRepository;
	getItemById(itemId: string): RepositoryItem | undefined;
	hydrateItem?(
		accountId: string,
		accountEmail: string,
		itemId: string,
	): Promise<void>;
	enqueue(command: ItemSyncCommand): Promise<void>;
	now(): number;
	newOperationId(): string;
}

interface CreateItemInput {
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountEmail: string;
}

interface UpdateItemInput {
	itemId: string;
	data: Partial<DecryptedItemData>;
	accountEmail?: string;
}

function toDecryptedData(item: RepositoryItem): DecryptedItemData {
	const data = { ...item };
	for (const key of [
		"id",
		"vaultId",
		"category",
		"favorite",
		"createdAt",
		"updatedAt",
		"deletedAt",
		"version",
		"lastModifiedBy",
		"encryptionVersion",
		"encryptedByUserId",
		"attachments",
		"accountEmail",
		"accountId",
		"serverUrl",
		"_encrypted",
		"vault",
		"account",
	]) {
		delete data[key];
	}
	return data as unknown as DecryptedItemData;
}

function toCommandPayload(payload: EncryptedPayload) {
	return {
		encryptedData: payload.ciphertext,
		encryptionIv: payload.iv,
		encryptionAlgorithm: payload.algorithm,
		encryptionVersion: payload.encryptionVersion,
		encryptedByUserId: payload.encryptedByUserId,
	};
}

export function createExtensionItemMutationModule(
	deps: ExtensionItemMutationDeps,
) {
	function resolveAccount(accountEmail: string) {
		const accountId = deps.resolveAccountIdByEmail(accountEmail);
		if (!accountId) {
			throw new Error(`No account found for Item mutation (${accountEmail})`);
		}
		return {
			accountId,
			accountEmail,
			repo: deps.getRepositoryForAccount(accountId),
		};
	}

	async function enqueue(
		input: Omit<
			ItemSyncCommand,
			"id" | "operationId" | "timestamp" | "retryCount"
		>,
	): Promise<void> {
		const operationId = deps.newOperationId();
		await deps.enqueue({
			...input,
			id: operationId,
			operationId,
			timestamp: deps.now(),
			retryCount: 0,
		});
	}

	return {
		async create(input: CreateItemInput) {
			const account = resolveAccount(input.accountEmail);
			const itemId = await deps.generateItemId();
			const encrypted = await account.repo.encryptWithVaultKey(
				input.vaultId,
				input.data,
				{ itemId, version: 1 },
			);
			await enqueue({
				accountId: account.accountId,
				accountEmail: account.accountEmail,
				type: "create",
				entityId: itemId,
				vaultId: input.vaultId,
				category: input.category,
				encryptedPayload: toCommandPayload(encrypted),
				baseVersion: 0,
			});
			return { itemId };
		},

		async update(input: UpdateItemInput) {
			const existing = deps.getItemById(input.itemId);
			const accountEmail = input.accountEmail ?? existing?.accountEmail;
			if (!accountEmail) {
				throw new Error(`No account found for Item ${input.itemId}`);
			}
			const account = resolveAccount(accountEmail);
			let repositoryItem = account.repo.getById(input.itemId);
			if (!repositoryItem && deps.hydrateItem) {
				await deps.hydrateItem(
					account.accountId,
					account.accountEmail,
					input.itemId,
				);
				repositoryItem = account.repo.getById(input.itemId);
			}
			if (!repositoryItem) {
				throw new Error(
					`Item ${input.itemId} was not found in account repository`,
				);
			}
			const data = deps.mergeItemUpdate(
				toDecryptedData(repositoryItem),
				input.data,
				repositoryItem.category,
			);
			const encrypted = await account.repo.encryptWithVaultKey(
				repositoryItem.vaultId,
				data,
				{
					itemId: repositoryItem.id,
					version: repositoryItem.version + 1,
				},
			);
			await enqueue({
				accountId: account.accountId,
				accountEmail: account.accountEmail,
				type: "update",
				entityId: repositoryItem.id,
				vaultId: repositoryItem.vaultId,
				encryptedPayload: toCommandPayload(encrypted),
				baseVersion: repositoryItem.version,
			});
		},
	};
}

const extensionItemMutations = createExtensionItemMutationModule({
	generateItemId: () => core.items.generateItemId(),
	mergeItemUpdate: (existing, update, category) =>
		core.items.mergeItemUpdate(existing, update, category),
	resolveAccountIdByEmail: (email) =>
		core.vaultCoordinator.resolveAccountIdByEmail(email),
	getRepositoryForAccount: (accountId) =>
		core.vaultCoordinator.getRepositoryForAccount(
			accountId,
		) as ExtensionItemMutationRepository,
	getItemById: (itemId) =>
		core.vaultCoordinator.getById(itemId) as RepositoryItem | undefined,
	hydrateItem: async (accountId, accountEmail, itemId) => {
		const client = await syncCacheService.getClientForAccountId(accountId);
		if (!client) {
			throw new Error(`No authenticated client for account ${accountId}`);
		}
		const { data: item } = await client.items.get(itemId);
		const cachedItem: CachedEncryptedItem = {
			id: item.id,
			vaultId: item.vaultId,
			accountId,
			accountEmail,
			category: item.category,
			favorite: item.favorite,
			encryptedData: item.encryptedData,
			encryptionIv: item.encryptionIv,
			encryptionAlgorithm: item.encryptionAlgorithm,
			version: item.version,
			lastModifiedBy: item.lastModifiedBy ?? null,
			encryptionVersion: item.encryptionVersion ?? undefined,
			encryptedByUserId: item.encryptedByUserId ?? undefined,
			createdAt: String(item.createdAt),
			updatedAt: String(item.updatedAt),
			deletedAt: item.deletedAt ? String(item.deletedAt) : null,
			attachments: item.attachments?.map((attachment) => ({
				...attachment,
				encryptedContentTypeIv: attachment.encryptedContentTypeIv ?? null,
				uploadedBy: attachment.uploadedBy ?? null,
			})),
		};
		await core.vaultCoordinator.upsertCachedItem(cachedItem, accountId);
	},
	enqueue: enqueueOutboundCommand,
	now: Date.now,
	newOperationId: () =>
		globalThis.crypto?.randomUUID?.() ??
		`extension-item-${Date.now()}-${Math.random().toString(36).slice(2)}`,
});

export const createExtensionItem = extensionItemMutations.create;
export const updateExtensionItem = extensionItemMutations.update;
