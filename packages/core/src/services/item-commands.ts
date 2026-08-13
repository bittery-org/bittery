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
	accountId?: string;
	accountEmail?: string;
};
export type UpdateItemIntent = {
	type: "update";
	itemId: string;
	vaultId?: string;
	data: Partial<DecryptedItemData>;
	accountEmail?: string;
};
export type ItemLifecycleIntent =
	| {
			type: "delete" | "toggle_favorite";
			itemId: string;
			vaultId: string;
			favorite?: boolean;
	  }
	| { type: "restore" | "permanent_delete"; itemId: string; vaultId: string };
export type MoveItemIntent = {
	type: "move";
	itemId: string;
	sourceVaultId: string;
	targetVaultId: string;
	category: ItemCategory;
	decryptedData: DecryptedItemData;
	targetAccountId?: string;
	targetAccountEmail?: string;
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
	findAccountForItem(itemId: string): { accountId: string } | undefined;
	findAccountForVault(vaultId: string): { accountId: string } | undefined;
	resolveAccountIdByEmail(email: string): string | undefined;
	getAccountInfo(accountId: string): { email: string } | undefined;
	getById(itemId: string, accountId?: string): RepositoryItem | undefined;
	getDeleted(accountId?: string): RepositoryItem[];
	getVaultById(vaultId: string, accountId: string): unknown;
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

	private requireVault(
		vaultId: string,
		accountId?: string,
		accountEmail?: string,
	) {
		const resolvedId =
			accountId ??
			(accountEmail
				? this.deps.repository.resolveAccountIdByEmail(accountEmail)
				: undefined) ??
			this.deps.repository.findAccountForVault(vaultId)?.accountId;
		const info = resolvedId
			? this.deps.repository.getAccountInfo(resolvedId)
			: undefined;
		const account =
			resolvedId && info
				? { accountId: resolvedId, accountEmail: info.email }
				: undefined;
		if (!account)
			throw new Error(`No account repository found for vault ${vaultId}`);
		return account;
	}

	private async requireItem(
		itemId: string,
		includeDeleted = false,
		vaultId?: string,
		accountEmail?: string,
	) {
		let accountId = this.deps.repository.findAccountForItem(itemId)?.accountId;
		if (!accountId && accountEmail)
			accountId = this.deps.repository.resolveAccountIdByEmail(accountEmail);
		const info = accountId
			? this.deps.repository.getAccountInfo(accountId)
			: undefined;
		const account =
			accountId && info ? { accountId, accountEmail: info.email } : undefined;
		if (!account)
			throw new Error(`No account repository found for item ${itemId}`);
		let item =
			this.deps.repository.getById(itemId, account.accountId) ??
			(includeDeleted
				? this.deps.repository
						.getDeleted(account.accountId)
						.find((entry) => entry.id === itemId)
				: undefined);
		if (!item && this.deps.hydrateItem) {
			await this.deps.hydrateItem(account, itemId);
			item =
				this.deps.repository.getById(itemId, account.accountId) ??
				(includeDeleted
					? this.deps.repository
							.getDeleted(account.accountId)
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
		const account = this.requireVault(
			intent.vaultId,
			intent.accountId,
			intent.accountEmail,
		);
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
		const { account, item } = await this.requireItem(
			intent.itemId,
			false,
			undefined,
			intent.accountEmail,
		);
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
		const { account, item } = await this.requireItem(
			intent.itemId,
			includeDeleted,
			includeDeleted ? intent.vaultId : undefined,
		);
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
		const { account: source, item } = await this.requireItem(intent.itemId);
		const vaultHint = this.deps.repository.getVaultById(
			intent.targetVaultId,
			source.accountId,
		);
		const target = this.requireVault(
			intent.targetVaultId,
			intent.targetAccountId ?? (vaultHint ? source.accountId : undefined),
			intent.targetAccountEmail,
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
				targetAccountEmail: target.accountEmail,
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
