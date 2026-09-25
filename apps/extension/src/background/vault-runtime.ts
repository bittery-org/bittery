import { ClientRuntime } from "@bittery/core/services/client-runtime";
import type { MaterialPublication } from "@bittery/core/services/material-publication";
import { itemCache, storage } from "../lib/storage";
import { vaultRepository } from "../lib/vault-runtime";
import { localMaterialPublication } from "./local-material-publication";

export const backgroundClientRuntime = new ClientRuntime({
	storage,
	itemCache,
	vaultRepository,
	materialPublication: localMaterialPublication,
});

/** Re-read cross-context account state, then wait for this runtime's local opening. */
export async function reconcileClientRuntime(
	runtime: Pick<ClientRuntime, "accounts" | "vaultRuntime">,
	publication?: MaterialPublication,
): Promise<void> {
	publication?.check();
	await runtime.accounts.refresh(publication);
	publication?.check();
	await runtime.vaultRuntime.retry(publication);
	publication?.check();
}
