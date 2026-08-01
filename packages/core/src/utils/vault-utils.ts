/**
 * Vault Utilities
 *
 * Compatibility wrappers around core vault services.
 */

import type { AccountStore } from "@bittery/storage";
import {
	type RpcVaultClient,
	refreshVaultKeys as refreshVaultKeysCore,
} from "../services/vault-service";

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	rpcClient: RpcVaultClient,
	storage: AccountStore,
	accountEmail?: string,
): Promise<void> {
	await refreshVaultKeysCore(rpcClient, storage, accountEmail);
}
