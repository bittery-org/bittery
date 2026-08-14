import { getAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import { itemCache, storage } from "../lib/storage";
import { vaultRepository } from "../lib/vault-runtime";

/** Process-local Vault lifetime for the service worker's command and Sync modules. */
export const accountManager = getAccountSessionManager({ storage, itemCache });
export const vaultRuntime = new AccountVaultRuntime(
	accountManager,
	vaultRepository,
);
vaultRuntime.start();

/** Re-read cross-context account state, then wait for the latest local opening. */
export async function reconcileVaultRuntimeFromStorage(): Promise<void> {
	await accountManager.refresh();
	await vaultRuntime.retry();
}
