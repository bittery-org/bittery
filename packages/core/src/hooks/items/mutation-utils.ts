import { useTRPCClient } from "@bittery/shared/trpc";
import type { DecryptedItemData } from "@bittery/shared/types";
import type { IPendingMutationQueue } from "@bittery/types";
import {
	useCoreContext,
	usePlatformSync,
	useQueryInvalidator,
} from "../../context/platform-context";
import type { CoreContext } from "../../core-context";
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
	| "toggle_favorite";

interface BasePendingMutation {
	type: LocalFirstMutationType;
	entityId: string;
	vaultId: string;
	targetVaultId?: string;
	category?: string;
	encryptedPayload?: {
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
	};
	favorite?: boolean;
	baseVersion: number;
	accountEmail: string;
}

export interface LocalItemMutationContext {
	accountEmail: string;
	repo: VaultRepository;
	item: VaultRepositoryItem;
	baseVersion: number;
}

interface EncryptedPayloadLike {
	ciphertext: string;
	iv: string;
	algorithm: string;
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
): void {
	queue.enqueue({
		id: createLocalId("mutation"),
		...mutation,
		timestamp: Date.now(),
		retryCount: 0,
	});
}

export function toQueueEncryptedPayload(
	payload: EncryptedPayloadLike,
): NonNullable<BasePendingMutation["encryptedPayload"]> {
	return {
		encryptedData: payload.ciphertext,
		encryptionIv: payload.iv,
		encryptionAlgorithm: payload.algorithm,
	};
}

export function requireRepositoryForVault(
	core: CoreContext,
	vaultId: string,
	accountEmail?: string,
): { accountEmail: string; repo: VaultRepository } {
	const resolvedAccountEmail =
		accountEmail ?? core.vaultCoordinator.findAccountForVault(vaultId)?.email;
	if (!resolvedAccountEmail) {
		throw new Error(`No account repository found for vault ${vaultId}`);
	}
	return {
		accountEmail: resolvedAccountEmail,
		repo: core.vaultCoordinator.getRepositoryForEmail(resolvedAccountEmail),
	};
}

export function requireLocalItemMutationContext(
	core: CoreContext,
	itemId: string,
): LocalItemMutationContext {
	const accountForItem = core.vaultCoordinator.findAccountForItem(itemId);
	if (!accountForItem) {
		throw new Error(`No account repository found for item ${itemId}`);
	}

	const existing = accountForItem.repo.getById(itemId);
	if (!existing) {
		throw new Error(`Item ${itemId} was not found in local repository`);
	}

	return {
		accountEmail: accountForItem.email,
		repo: accountForItem.repo,
		item: existing,
		baseVersion: existing.version,
	};
}

export function enqueueItemMutation(
	queue: IPendingMutationQueue,
	context: Pick<LocalItemMutationContext, "accountEmail" | "baseVersion">,
	mutation: Omit<BasePendingMutation, "baseVersion" | "accountEmail">,
): void {
	enqueuePendingMutation(queue, {
		...mutation,
		baseVersion: context.baseVersion,
		accountEmail: context.accountEmail,
	});
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
	delete data.attachments;
	delete data._encrypted;
	delete data.vault;
	delete data.account;
	return data as unknown as DecryptedItemData;
}

export function useItemMutationRuntime() {
	const defaultClient = useTRPCClient();
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
