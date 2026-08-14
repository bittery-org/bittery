import { ClientRuntime } from "@bittery/core/services/client-runtime";
import { itemCache, storage } from "../lib/storage";
import { vaultRepository } from "../lib/vault-runtime";

export const backgroundClientRuntime = new ClientRuntime({
	storage,
	itemCache,
	vaultRepository,
});

/** Re-read cross-context account state, then wait for this runtime's local opening. */
export async function reconcileClientRuntime(
	runtime: Pick<ClientRuntime, "accounts" | "vaultRuntime">,
): Promise<void> {
	await runtime.accounts.refresh();
	await runtime.vaultRuntime.retry();
}
