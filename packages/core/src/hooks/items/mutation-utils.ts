import { useApiClient } from "@bittery/shared/api";
import type { DecryptedItemData } from "@bittery/shared/types";
import type { IPendingMutationQueue } from "@bittery/types";
import {
	useCoreContext,
	usePlatformSync,
	useQueryInvalidator,
} from "../../context/platform-context";
import type { CoreContext } from "../../core-context";
import {
	resolveRepositoryForItem,
	resolveRepositoryForVault,
} from "../../services/account-context-resolver";
import type {
	VaultRepository,
	VaultRepositoryItem,
} from "../../services/vault-repository";

type LocalFirstMutationType =
	| "create"
	| "update"
	| "delete"
	| "permanent_delete"
	| "restore"
	| "move"
	| "cross_account_move"
	| "toggle_favorite";

interface BasePendingMutation {
	type: LocalFirstMutationType;
	entityId: string;
	vaultId: string;
	targetVaultId?: string;
	targetAccountId?: string;
	targetAccountEmail?: string;
	targetItemId?: string;
	category?: string;
	encryptedPayload?: {
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
		encryptionVersion?: number;
		encryptedByUserId?: string;
	};
	favorite?: boolean;
	baseVersion: number;
	accountId: string;
	accountEmail: string;
}

export interface LocalItemMutationContext {
	accountId: string;
	accountEmail: string;
	repo: VaultRepository;
	item: VaultRepositoryItem;
	baseVersion: number;
}

interface LocalItemMutationContextOptions {
	vaultId?: string;
	includeDeleted?: boolean;
}

interface EncryptedPayloadLike {
	ciphertext: string;
	iv: string;
	algorithm: string;
	encryptionVersion?: number;
	encryptedByUserId?: string;
}

export function createLocalId(prefix: string): string {
	const random = globalThis?.crypto?.randomUUID?.();
	if (random) {
		return `${prefix}_${random}`;
	}
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function enqueuePendingMutation(
	queue: IPendingMutationQueue,
	mutation: BasePendingMutation,
	applyOptimistic?: () => Promise<void>,
): Promise<void> {
	return queue.enqueue(
		{
			id: createLocalId("mutation"),
			...mutation,
			timestamp: Date.now(),
			retryCount: 0,
		},
		applyOptimistic,
	);
}

export function toQueueEncryptedPayload(
	payload: EncryptedPayloadLike,
): NonNullable<BasePendingMutation["encryptedPayload"]> {
	return {
		encryptedData: payload.ciphertext,
		encryptionIv: payload.iv,
		encryptionAlgorithm: payload.algorithm,
		encryptionVersion: payload.encryptionVersion,
		encryptedByUserId: payload.encryptedByUserId,
	};
}

export function requireRepositoryForVault(
	core: CoreContext,
	vaultId: string,
	accountId?: string,
	accountEmail?: string,
): { accountId: string; accountEmail: string; repo: VaultRepository } {
	const resolved = resolveRepositoryForVault(
		core,
		vaultId,
		accountId,
		accountEmail,
	);
	if (!resolved) {
		throw new Error(`No account repository found for vault ${vaultId}`);
	}
	return resolved;
}

export function requireLocalItemMutationContext(
	core: CoreContext,
	itemId: string,
	options: LocalItemMutationContextOptions = {},
): LocalItemMutationContext {
	const resolved = options.vaultId
		? resolveRepositoryForVault(core, options.vaultId)
		: resolveRepositoryForItem(core, itemId);
	if (!resolved) {
		throw new Error(`No account repository found for item ${itemId}`);
	}

	const existing =
		resolved.repo.getById(itemId) ??
		(options.includeDeleted
			? resolved.repo.getDeleted().find((item) => item.id === itemId)
			: undefined);
	if (!existing) {
		throw new Error(`Item ${itemId} was not found in local repository`);
	}

	if (options.vaultId && existing.vaultId !== options.vaultId) {
		throw new Error(
			`Item ${itemId} does not belong to vault ${options.vaultId}`,
		);
	}

	return {
		accountId: resolved.accountId,
		accountEmail: resolved.accountEmail,
		repo: resolved.repo,
		item: existing,
		baseVersion: existing.version,
	};
}

export async function enqueueItemMutation(
	queue: IPendingMutationQueue,
	context: Pick<
		LocalItemMutationContext,
		"accountId" | "accountEmail" | "baseVersion"
	>,
	mutation: Omit<
		BasePendingMutation,
		"baseVersion" | "accountId" | "accountEmail"
	>,
	applyOptimistic?: () => Promise<void>,
): Promise<void> {
	await enqueuePendingMutation(
		queue,
		{
			...mutation,
			baseVersion: context.baseVersion,
			accountId: context.accountId,
			accountEmail: context.accountEmail,
		},
		applyOptimistic,
	);
}

export function extractDecryptedItemData(item: unknown): DecryptedItemData {
	const data = { ...(item as Record<string, unknown>) };
	delete data.id;
	delete data.vaultId;
	delete data.category;
	delete data.favorite;
	delete data.createdAt;
	delete data.updatedAt;
	delete data.deletedAt;
	delete data.version;
	delete data.lastModifiedBy;
	delete data.encryptionVersion;
	delete data.encryptedByUserId;
	delete data.attachments;
	delete data.accountEmail;
	delete data.accountId;
	delete data.serverUrl;
	delete data._encrypted;
	delete data.vault;
	delete data.account;
	return data as unknown as DecryptedItemData;
}

export function useItemMutationRuntime() {
	const defaultClient = useApiClient();
	const core = useCoreContext();
	const sync = usePlatformSync();
	const invalidator = useQueryInvalidator();
	if (!sync) {
		throw new Error(
			"Item mutation hooks require sync context with outboundQueue",
		);
	}

	return {
		defaultClient,
		core,
		invalidator,
		queue: sync.outboundQueue,
	};
}

export async function refreshRepositoriesFromServer(
	core: CoreContext,
): Promise<void> {
	const { accountsInfo } = await core.accounts.resolveAccounts();
	if (accountsInfo.length === 0) {
		return;
	}
	await core.vaultCoordinator.refreshFromServer(accountsInfo);
}
