import type { CoreContext } from "../core-context";
import type { VaultRepository } from "./vault-repository";

export interface ResolvedAccountRepository {
	accountEmail: string;
	repo: VaultRepository;
}

export function resolveRepositoryForVault(
	core: CoreContext,
	vaultId: string,
	accountEmailHint?: string,
): ResolvedAccountRepository | undefined {
	if (accountEmailHint) {
		return {
			accountEmail: accountEmailHint,
			repo: core.vaultCoordinator.getRepositoryForEmail(accountEmailHint),
		};
	}

	const located = core.vaultCoordinator.findAccountForVault(vaultId);
	if (!located) {
		return undefined;
	}

	return {
		accountEmail: located.email,
		repo: located.repo,
	};
}

export function resolveRepositoryForItem(
	core: CoreContext,
	itemId: string,
): ResolvedAccountRepository | undefined {
	const coordinatedItem = core.vaultCoordinator.getById(itemId);
	const contextualAccountEmail =
		coordinatedItem?.accountEmail ?? coordinatedItem?.account?.email;

	if (contextualAccountEmail) {
		return {
			accountEmail: contextualAccountEmail,
			repo: core.vaultCoordinator.getRepositoryForEmail(contextualAccountEmail),
		};
	}

	const located = core.vaultCoordinator.findAccountForItem(itemId);
	if (!located) {
		return undefined;
	}

	return {
		accountEmail: located.email,
		repo: located.repo,
	};
}
