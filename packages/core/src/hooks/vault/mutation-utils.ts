import { useRPCClient } from "@bittery/shared/rpc";
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
	const defaultClient = useRPCClient();
	const core = useCoreContext();
	const invalidator = useQueryInvalidator();

	return async (accountId: string) => {
		await core.vaults.refreshVaultKeys(defaultClient, accountId);
		await refreshRepositoriesFromServer(core);
		await invalidator.invalidateVaultKeys();
	};
}
