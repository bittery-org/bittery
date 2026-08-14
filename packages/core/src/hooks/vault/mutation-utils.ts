import type { IQueryInvalidator } from "@bittery/sync";
import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";

/** The slice of the core a vault mutation needs to refresh itself. */
export interface VaultMutationCore {
	vaults: { refreshVaultKeys(accountId: string): Promise<void> };
	vaultRepository: {
		removeCachedVault(vaultId: string, accountId: string): Promise<void>;
	};
}

type VaultKeyInvalidator = Pick<IQueryInvalidator, "invalidateVaultKeys">;

/**
 * The refresh every vault mutation shares: re-pull the account's vault keys,
 * then invalidate the vault-key queries.
 *
 * Deliberately does *not* re-bootstrap the repositories. The vault key list
 * carries the name, icon and image of every vault, so create, rename and
 * convert-type are fully covered by it, and a re-download of every item of
 * every vault costs ~1500 store writes on desktop — enough to hang the dialog
 * that awaits it.
 */
export async function refreshAfterVaultMutation(
	core: VaultMutationCore,
	invalidator: VaultKeyInvalidator,
	accountId: string,
): Promise<void> {
	await core.vaults.refreshVaultKeys(accountId);
	await invalidator.invalidateVaultKeys();
}

/**
 * Deletion additionally needs the vault's items gone from the local cache;
 * the vault key list alone never mentions them again.
 */
export async function refreshAfterVaultDeletion(
	core: VaultMutationCore,
	invalidator: VaultKeyInvalidator,
	deleted: { vaultId: string; accountId: string },
): Promise<void> {
	await core.vaultRepository.removeCachedVault(
		deleted.vaultId,
		deleted.accountId,
	);
	await refreshAfterVaultMutation(core, invalidator, deleted.accountId);
}

export function useRefreshAfterVaultMutation(): (
	accountId: string,
) => Promise<void> {
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return (accountId: string) =>
		refreshAfterVaultMutation(core, invalidator, accountId);
}

export function useRefreshAfterVaultDeletion(): (deleted: {
	vaultId: string;
	accountId: string;
}) => Promise<void> {
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return (deleted) => refreshAfterVaultDeletion(core, invalidator, deleted);
}
