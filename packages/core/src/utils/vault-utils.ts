/**
 * Vault Utilities
 *
 * Compatibility wrappers around core vault services.
 */

import type { IStorageAdapter } from "@bittery/storage/adapter";
import {
	type RpcVaultClient,
	refreshVaultKeys as refreshVaultKeysCore,
} from "../services/vault-service";

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	rpcClient: RpcVaultClient,
	storage: IStorageAdapter,
	accountEmail?: string,
): Promise<void> {
	await refreshVaultKeysCore(rpcClient, storage, accountEmail);
}
