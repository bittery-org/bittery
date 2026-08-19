import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import { ClientRuntime } from "@bittery/core/services/client-runtime";
import { notifyWorkerAccountScopeChanged } from "./account-scope-notification";
import { itemCache, storage } from "./storage";
import { vaultRepository } from "./vault-runtime";

export interface PopupAccountVaultRuntime {
	manager: AccountSessionManager;
	vaultRuntime: AccountVaultRuntime;
	start(): void;
	dispose(): void;
	reconcileFromStorage(): Promise<void>;
	reloadFromCache(): Promise<void>;
}

export function createPopupAccountVaultRuntime(): PopupAccountVaultRuntime {
	const runtime = new ClientRuntime({
		storage,
		itemCache,
		vaultRepository,
		onActiveChanged: () => notifyWorkerAccountScopeChanged(),
	});
	return {
		manager: runtime.accounts,
		vaultRuntime: runtime.vaultRuntime,
		start: () => runtime.start(),
		dispose: () => runtime.dispose(),
		async reconcileFromStorage() {
			await runtime.accounts.refresh();
		},
		async reloadFromCache() {
			// The worker writes the durable cache in another JavaScript context. Drop
			// this popup's in-memory replicas before reopening the current local scope.
			vaultRepository.clear();
			await runtime.vaultRuntime.retry();
		},
	};
}
