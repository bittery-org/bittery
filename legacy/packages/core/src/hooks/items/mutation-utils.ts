import { stripToDecryptedData } from "@bittery/shared/item-mapping";
import type { DecryptedItemData } from "@bittery/shared/types";
import {
	useCoreContext,
	usePlatformSync,
	useQueryInvalidator,
} from "../../context/platform-context";
import type { CoreContext } from "../../core-context";

export function extractDecryptedItemData(item: unknown): DecryptedItemData {
	return stripToDecryptedData(item);
}

export function useItemMutationRuntime() {
	const core = useCoreContext();
	const sync = usePlatformSync();
	const invalidator = useQueryInvalidator();
	if (!sync) {
		throw new Error(
			"Item mutation hooks require sync context with outboundQueue",
		);
	}

	return {
		commands: core.itemCommands,
		core,
		invalidator,
	};
}

export async function refreshRepositoriesFromServer(
	core: CoreContext,
): Promise<void> {
	const { accountsInfo } = await core.accounts.resolveAccounts();
	if (accountsInfo.length === 0) {
		return;
	}
	await core.vaultRepository.refreshFromServer(accountsInfo);
}
