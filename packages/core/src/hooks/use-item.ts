/**
 * useItem Hook - Unified Single Item Fetching
 *
 * Reads from the local VaultRepositoryCoordinator.
 */

import type { DecryptedItemData } from "@bittery/shared/types";
import { useMemo } from "react";
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

function extractDecryptedData(item: any): DecryptedItemData {
	const data = { ...item } as Record<string, unknown>;
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
		if (!enabled || !itemId) {
			return undefined;
		}
		return vaultCoordinator.getById(itemId);
	}, [vaultCoordinator, enabled, itemId, snapshot]);

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
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		deletedAt: item.deletedAt,
		attachments: item.attachments,
	};

	return {
		rawItem,
		decryptedData: extractDecryptedData(item),
		isLoading,
		error: null,
		refetch,
	};
}
