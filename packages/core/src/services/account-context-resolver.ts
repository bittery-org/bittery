import type { CoreContext } from "../core-context";
import type { VaultRepository } from "./vault-repository";

export interface ResolvedAccountRepository {
	accountId: string;
	accountEmail: string;
	repo: VaultRepository;
}

export function resolveRepositoryForVault(
	core: CoreContext,
	vaultId: string,
	accountIdHint?: string,
	accountEmailHint?: string,
): ResolvedAccountRepository | undefined {
	if (accountIdHint) {
		const repo = core.vaultCoordinator.getRepositoryForAccount(accountIdHint);
		return {
			accountId: accountIdHint,
			accountEmail: repo.getAccountEmail() ?? accountEmailHint ?? "",
			repo,
		};
	}
	if (accountEmailHint) {
		const accountId =
			core.vaultCoordinator.resolveAccountIdByEmail(accountEmailHint);
		if (!accountId) {
			return undefined;
		}
		return {
			accountId,
			accountEmail: accountEmailHint,
			repo: core.vaultCoordinator.getRepositoryForAccount(accountId),
		};
	}

	const located = core.vaultCoordinator.findAccountForVault(vaultId);
	if (!located) {
		return undefined;
	}

	return {
		accountId: located.accountId,
		accountEmail: located.repo.getAccountEmail() ?? "",
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
		const accountId =
			coordinatedItem?.account?.accountId ??
			core.vaultCoordinator.resolveAccountIdByEmail(contextualAccountEmail);
		if (!accountId) {
			return undefined;
		}
		return {
			accountId,
			accountEmail: contextualAccountEmail,
			repo: core.vaultCoordinator.getRepositoryForAccount(accountId),
		};
	}

	const located = core.vaultCoordinator.findAccountForItem(itemId);
	if (!located) {
		return undefined;
	}

	return {
		accountId: located.accountId,
		accountEmail: located.repo.getAccountEmail() ?? "",
		repo: located.repo,
	};
}
