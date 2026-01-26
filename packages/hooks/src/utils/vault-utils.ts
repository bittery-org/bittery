/**
 * Vault Utilities
 *
 * Shared utility functions for vault operations.
 */

import type { IStorageAdapter } from "@bittery/storage/adapter";

/**
 * Result type from vault.list query
 */
interface VaultListItem {
	id: string;
	name: string;
	type: "personal" | "team";
	icon: string | null;
	imageUrl: string | null;
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

/**
 * tRPC client interface for vault operations
 */
interface TRPCVaultClient {
	vault: {
		list: {
			query: () => Promise<VaultListItem[]>;
		};
	};
}

/**
 * Refresh vault keys from server and store in local storage.
 * Called after vault operations to ensure key cache is up to date.
 *
 * @param trpcClient - The tRPC client instance
 * @param storage - The storage adapter instance
 */
export async function refreshVaultKeys(
	trpcClient: TRPCVaultClient,
	storage: IStorageAdapter,
): Promise<void> {
	const vaultList = await trpcClient.vault.list.query();
	await storage.storeVaultKeys(
		vaultList.map((v) => ({
			vaultId: v.id,
			vaultName: v.name,
			vaultType: v.type,
			vaultIcon: v.icon,
			vaultImageUrl: v.imageUrl,
			encryptedVaultKey: v.encryptedVaultKey,
			role: v.role,
		})),
	);
}
