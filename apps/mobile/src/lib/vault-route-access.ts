import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { AccountStore } from "@bittery/storage";

export type VaultRouteAccess = "login" | "unlock" | "ready";

/**
 * Mirrors desktop's `resolveVaultRouteAccess` decision
 * (`apps/desktop/src/lib/vault-route-access.ts`) — same manager/storage contract, so `/vault`
 * gates access identically on both platforms. Duplicated rather than shared because apps cannot
 * import from one another (only from `packages/`); there is no layout here to duplicate, only
 * the access decision.
 */
export async function resolveVaultRouteAccess(
	manager: Pick<
		AccountSessionManager,
		"getActiveAccount" | "isInitialized" | "isUnlocked" | "unlockAccount"
	>,
	storage: Pick<AccountStore, "getStoredSecretKey" | "isSessionValid">,
): Promise<VaultRouteAccess> {
	const activeAccount = manager.getActiveAccount();
	if (!activeAccount) {
		return "login";
	}
	if (manager.isInitialized() && manager.isUnlocked(activeAccount)) {
		return "ready";
	}
	const [hasSecretKey, sessionValid] = await Promise.all([
		storage.getStoredSecretKey(activeAccount),
		storage.isSessionValid(activeAccount),
	]);
	if (!hasSecretKey || !sessionValid) {
		return "unlock";
	}

	return (await manager.unlockAccount(activeAccount, true))
		? "ready"
		: "unlock";
}
