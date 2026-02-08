/**
 * Vault Utilities
 *
 * Compatibility wrappers around core vault services.
 */

import type { IStorageAdapter } from "@bittery/storage/adapter";
import {
	refreshVaultKeys as refreshVaultKeysCore,
	type TRPCVaultClient,
} from "../services/vault-service";

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	trpcClient: TRPCVaultClient,
	storage: IStorageAdapter,
	accountEmail?: string,
): Promise<void> {
	await refreshVaultKeysCore(trpcClient, storage, accountEmail);
}
