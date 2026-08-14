import {
	type AccountSessionManager,
	getAccountSessionManager,
} from "@bittery/core/services/account-session-manager";
import { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import type { VaultRepository } from "@bittery/core/services/vault-repository";
import { notifyWorkerAccountScopeChanged } from "./account-scope-notification";
import { itemCache, storage } from "./storage";
import { vaultRepository } from "./vault-runtime";

export interface PopupAccountVaultRuntime {
	manager: AccountSessionManager;
	vaultRuntime: AccountVaultRuntime;
	reconcileFromStorage(): Promise<void>;
	reloadFromCache(): Promise<void>;
}

export function createPopupAccountVaultRuntime(
	manager: AccountSessionManager,
	repository: VaultRepository,
): PopupAccountVaultRuntime {
	const vaultRuntime = new AccountVaultRuntime(manager, repository);
	vaultRuntime.start();
	return {
		manager,
		vaultRuntime,
		async reconcileFromStorage() {
			await manager.refresh();
		},
		async reloadFromCache() {
			// The worker writes the durable cache in another JavaScript context. Drop
			// this popup's in-memory replicas before reopening the current local scope.
			repository.clear();
			await vaultRuntime.retry();
		},
	};
}

/** Constructed at module load, before any popup provider or read hook renders. */
export const popupAccountManager = getAccountSessionManager({
	storage,
	itemCache,
	onActiveChanged: () => notifyWorkerAccountScopeChanged(),
});

export const popupAccountVaultRuntime = createPopupAccountVaultRuntime(
	popupAccountManager,
	vaultRepository,
);

export const vaultRuntime = popupAccountVaultRuntime.vaultRuntime;
