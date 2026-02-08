/**
 * Vault Utilities
 *
 * Compatibility wrappers around @bittery/core vault services.
 */

import {
	refreshVaultKeys as refreshVaultKeysCore,
	type TRPCVaultClient,
} from "@bittery/core";
import type { IStorageAdapter } from "@bittery/storage/adapter";

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
