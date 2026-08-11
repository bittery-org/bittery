/**
 * useItem Hook - Unified Single Item Fetching
 *
 * Reads from the local VaultRepositoryCoordinator.
 */

import type { DecryptedItemData } from "@bittery/shared/types";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useCoreContext } from "../context/platform-context";
import { extractDecryptedItemData } from "./items/mutation-utils";
import { useVaultRepositorySync } from "./use-vault-repository-sync";

export interface UseItemOptions {
	accountEmail?: string;
	enabled?: boolean;
}

export interface UseItemResult {
	rawItem: any;
	decryptedData: DecryptedItemData | null | undefined;
	isLoading: boolean;
	error: Error | null;
	refetch: () => void;
}

export interface EncryptionContextMigrationItem {
	id: string;
	accountId?: string;
	account?: { accountId?: string };
	version?: number;
	encryptionContextPendingMigration?: boolean;
}

export function useOpenedItemEncryptionContextMigration(
	item: EncryptionContextMigrationItem | null | undefined,
): void {
	const core = useCoreContext();
	const accountId = item?.accountId ?? item?.account?.accountId;
	useQuery({
		queryKey: [
			"item-encryption-context-migration",
			accountId,
			item?.id,
			item?.version,
		],
		enabled:
			Boolean(item?.encryptionContextPendingMigration) &&
			Boolean(accountId) &&
			Boolean(item?.id),
		queryFn: async () => {
			await core.vaultCoordinator.publishPendingEncryptionContextMigration(
				accountId as string,
				item?.id as string,
			);
			return true;
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * Hook to fetch and decrypt a single item.
 */
export function useItem(
	itemId: string,
	options: UseItemOptions = {},
): UseItemResult {
	const { enabled = true } = options;
	const { isLoading, refetch, snapshot, vaultCoordinator } =
		useVaultRepositorySync({
			enabled,
			requiredId: itemId,
		});

	const item = useMemo(() => {
		// Snapshot is an invalidation signal from the coordinator store.
		void snapshot;

		if (!enabled || !itemId) {
			return undefined;
		}
		return vaultCoordinator.getById(itemId);
	}, [vaultCoordinator, enabled, itemId, snapshot]);

	useOpenedItemEncryptionContextMigration(item);

	if (!enabled || !itemId) {
		return {
			rawItem: null,
			decryptedData: null,
			isLoading: false,
			error: null,
			refetch,
		};
	}

	if (!item) {
		return {
			rawItem: null,
			decryptedData: null,
			isLoading,
			error: null,
			refetch,
		};
	}

	const rawItem = {
		id: item.id,
		vaultId: item.vaultId,
		category: item.category,
		favorite: item.favorite,
		encryptedData: item._encrypted.data,
		encryptionIv: item._encrypted.iv,
		encryptionAlgorithm: item._encrypted.algorithm,
		version: item.version,
		lastModifiedBy: item.lastModifiedBy,
		encryptionVersion: item.encryptionVersion,
		encryptedByUserId: item.encryptedByUserId,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		deletedAt: item.deletedAt,
		attachments: item.attachments,
		accountEmail: item.accountEmail ?? item.account?.email,
		accountId: item.accountId ?? item.account?.accountId,
		serverUrl: item.serverUrl ?? item.account?.serverUrl,
		encryptionContextPendingMigration: item.encryptionContextPendingMigration,
		account: item.account,
	};

	return {
		rawItem,
		decryptedData: extractDecryptedItemData(item),
		isLoading,
		error: null,
		refetch,
	};
}
