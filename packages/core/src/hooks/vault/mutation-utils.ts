import {
	useCoreContext,
	useQueryInvalidator,
} from "../../context/platform-context";
import { refreshRepositoriesFromServer } from "../items/mutation-utils";

/**
 * The refresh every vault mutation shares: re-pull the account's vault keys,
 * rehydrate the repositories, then invalidate the vault-key queries.
 */
export function useRefreshAfterVaultMutation(): (
	accountId: string,
) => Promise<void> {
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return async (accountId: string) => {
		await core.vaults.refreshVaultKeys(accountId);
		await refreshRepositoriesFromServer(core);
		await invalidator.invalidateVaultKeys();
	};
}
