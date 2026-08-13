import {
	type EncryptedItemPayload,
	stripToDecryptedData,
	toEncryptedPayload,
} from "@bittery/shared/item-mapping";
import { applyPasswordHistoryOnPasswordChange } from "@bittery/shared/password-history";
import type { DecryptedItemData, ItemCategory } from "@bittery/shared/types";
import type { ItemSyncCommand } from "@bittery/types";

export type CreateItemIntent = {
	type: "create";
	vaultId: string;
	category: ItemCategory;
	data: DecryptedItemData;
	accountId: string;
};
export type UpdateItemIntent = {
	type: "update";
	itemId: string;
	vaultId?: string;
	data: Partial<DecryptedItemData>;
	accountId: string;
};
export type ItemLifecycleIntent =
	| {
			type: "delete" | "toggle_favorite";
			itemId: string;
			vaultId: string;
			accountId: string;
			favorite?: boolean;
	  }
	| {
			type: "restore" | "permanent_delete";
			itemId: string;
			vaultId: string;
			accountId: string;
	  };
export type MoveItemIntent = {
	type: "move";
	itemId: string;
	sourceVaultId: string;
	targetVaultId: string;
	category: ItemCategory;
	decryptedData: DecryptedItemData;
	accountId: string;
	targetAccountId: string;
};

export type ItemIntent =
	| CreateItemIntent
	| UpdateItemIntent
	| ItemLifecycleIntent
	| MoveItemIntent;

export interface CreateItemCommandResult {
	itemId: string;
}

export type MoveItemCommandResult =
	| { crossAccount: false }
	| { crossAccount: true; newItemId: string };

export interface CommandQueuePort {
	enqueue(
		command: ItemSyncCommand,
		applyOptimistic?: () => Promise<void>,
	): Promise<void>;
}

interface RepositoryItem {
	id: string;
	vaultId: string;
	category: ItemCategory;
	version: number;
	deletedAt?: string | null;
}

export interface ItemCommandAccount {
	accountId: string;
	accountEmail: string;
}

export interface ItemCommandRepositoryPort {
	findAccountForVault(vaultId: string): { accountId: string } | undefined;
	getAccountInfo(accountId: string): { email: string } | undefined;
	getById(itemId: string, accountId: string): RepositoryItem | undefined;
	getDeleted(accountId: string): RepositoryItem[];
	encryptForVault(input: {
		accountId: string;
		vaultId: string;
		data: DecryptedItemData;
		itemId: string;
		version: number;
		userId?: string;
	}): Promise<EncryptedItemPayload>;
}

interface ItemCommandsDeps {
	queue: CommandQueuePort;
	repository: ItemCommandRepositoryPort;
	resolveUserId(accountId: string): Promise<string>;
	generateId(): Promise<string>;
	now(): number;
	hydrateItem?(account: ItemCommandAccount, itemId: string): Promise<void>;
	project?(command: ItemSyncCommand): Promise<void>;
}

export class ItemCommands {
	constructor(private readonly deps: ItemCommandsDeps) {}

	private merge(
		existing: DecryptedItemData,
		update: Partial<DecryptedItemData>,
		category: ItemCategory,
	): DecryptedItemData {
		const merged = { ...existing, ...update };
		if (category === "login") {
			merged.passwordHistory = applyPasswordHistoryOnPasswordChange({
				passwordHistory: merged.passwordHistory,
				previousPassword: existing.password,
				nextPassword: merged.password,
			});
		}
		return merged;
	}

	private async enqueue(
		account: ItemCommandAccount,
		baseVersion: number,
		command: Omit<
			ItemSyncCommand,
			| "id"
			| "operationId"
			| "timestamp"
			| "retryCount"
			| "accountId"
			| "accountEmail"
			| "baseVersion"
		>,
	) {
		const operationId = await this.deps.generateId();
		const durable: ItemSyncCommand = {
			...command,
			id: operationId,
			operationId,
			timestamp: this.deps.now(),
			retryCount: 0,
			accountId: account.accountId,
			accountEmail: account.accountEmail,
			baseVersion,
		};
		const project = this.deps.project;
		await this.deps.queue.enqueue(
			durable,
			project ? () => project(durable) : undefined,
		);
	}

	private requireVault(vaultId: string, accountId: string) {
		const vaultAccount = this.deps.repository.findAccountForVault(vaultId);
		const info = this.deps.repository.getAccountInfo(accountId);
		if (vaultAccount?.accountId !== accountId || !info) {
			throw new Error(`No account repository found for vault ${vaultId}`);
		}
		return { accountId, accountEmail: info.email };
	}

	private async requireItem(input: {
		itemId: string;
		accountId: string;
		includeDeleted?: boolean;
		vaultId?: string;
	}) {
		const { itemId, accountId, includeDeleted = false, vaultId } = input;
		const info = this.deps.repository.getAccountInfo(accountId);
		if (!info)
			throw new Error(`No account repository found for item ${itemId}`);
		const account = { accountId, accountEmail: info.email };
		let item =
			this.deps.repository.getById(itemId, accountId) ??
			(includeDeleted
				? this.deps.repository
						.getDeleted(accountId)
						.find((entry) => entry.id === itemId)
				: undefined);
		if (!item && this.deps.hydrateItem) {
			await this.deps.hydrateItem(account, itemId);
			item =
				this.deps.repository.getById(itemId, accountId) ??
				(includeDeleted
					? this.deps.repository
							.getDeleted(accountId)
							.find((entry) => entry.id === itemId)
					: undefined);
		}
		if (!item)
			throw new Error(`Item ${itemId} was not found in local repository`);
		if (vaultId && item.vaultId !== vaultId)
			throw new Error(`Item ${itemId} does not belong to vault ${vaultId}`);
		return { account, item };
	}

	execute(intent: CreateItemIntent): Promise<CreateItemCommandResult>;
	execute(intent: UpdateItemIntent): Promise<void>;
	execute(intent: ItemLifecycleIntent): Promise<void>;
	execute(intent: MoveItemIntent): Promise<MoveItemCommandResult>;
	async execute(intent: ItemIntent): Promise<unknown> {
		switch (intent.type) {
			case "create":
				return this.create(intent);
			case "update":
				return this.update(intent);
			case "move":
				return this.move(intent);
			case "delete":
			case "toggle_favorite":
			case "restore":
			case "permanent_delete":
				return this.changeLifecycle(intent);
		}
	}

	private async create(
		intent: CreateItemIntent,
	): Promise<CreateItemCommandResult> {
		const account = this.requireVault(intent.vaultId, intent.accountId);
		const itemId = await this.deps.generateId();
		const encrypted = await this.deps.repository.encryptForVault({
			accountId: account.accountId,
			vaultId: intent.vaultId,
			data: intent.data,
			itemId,
			version: 1,
		});
		await this.enqueue(account, 0, {
			type: "create",
			entityId: itemId,
			vaultId: intent.vaultId,
			category: intent.category,
			encryptedPayload: toEncryptedPayload(encrypted),
		});
		return { itemId };
	}

	private async update(intent: UpdateItemIntent): Promise<void> {
		const { account, item } = await this.requireItem({
			itemId: intent.itemId,
			accountId: intent.accountId,
			vaultId: intent.vaultId,
		});
		const data = this.merge(
			stripToDecryptedData(item),
			intent.data,
			item.category,
		);
		const encrypted = await this.deps.repository.encryptForVault({
			accountId: account.accountId,
			vaultId: item.vaultId,
			data,
			itemId: item.id,
			version: item.version + 1,
		});
		await this.enqueue(account, item.version, {
			type: "update",
			entityId: item.id,
			vaultId: item.vaultId,
			encryptedPayload: toEncryptedPayload(encrypted),
		});
	}

	private async changeLifecycle(intent: ItemLifecycleIntent): Promise<void> {
		const includeDeleted =
			intent.type === "restore" || intent.type === "permanent_delete";
		const { account, item } = await this.requireItem({
			itemId: intent.itemId,
			accountId: intent.accountId,
			includeDeleted,
			vaultId: intent.vaultId,
		});
		await this.enqueue(account, item.version, {
			type: intent.type,
			entityId: item.id,
			vaultId: intent.vaultId,
			...(intent.type === "toggle_favorite"
				? { favorite: intent.favorite ?? false }
				: {}),
		});
	}

	private async move(intent: MoveItemIntent): Promise<MoveItemCommandResult> {
		const { account: source, item } = await this.requireItem({
			itemId: intent.itemId,
			accountId: intent.accountId,
			vaultId: intent.sourceVaultId,
		});
		const target = this.requireVault(
			intent.targetVaultId,
			intent.targetAccountId,
		);
		if (source.accountId !== target.accountId) {
			const targetItemId = await this.deps.generateId();
			const encrypted = await this.deps.repository.encryptForVault({
				accountId: target.accountId,
				vaultId: intent.targetVaultId,
				data: intent.decryptedData,
				itemId: targetItemId,
				version: 1,
			});
			await this.enqueue(source, item.version, {
				type: "cross_account_move",
				entityId: item.id,
				vaultId: intent.sourceVaultId,
				targetVaultId: intent.targetVaultId,
				targetAccountId: target.accountId,
				targetItemId,
				category: intent.category,
				encryptedPayload: toEncryptedPayload(encrypted),
			});
			return {
				crossAccount: true,
				newItemId: targetItemId,
			};
		}
		const userId = await this.deps.resolveUserId(source.accountId);
		const encrypted = await this.deps.repository.encryptForVault({
			accountId: source.accountId,
			vaultId: intent.targetVaultId,
			data: intent.decryptedData,
			itemId: item.id,
			version: item.version + 1,
			userId,
		});
		await this.enqueue(source, item.version, {
			type: "move",
			entityId: item.id,
			vaultId: intent.sourceVaultId,
			targetVaultId: intent.targetVaultId,
			encryptedPayload: toEncryptedPayload(encrypted),
		});
		return { crossAccount: false };
	}
}
