import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";

export async function loadRecoveredAccountBootstrap(input: {
	token: string;
	serverUrl: string;
}) {
	const rpcClient = createAccountRpcClient(input.token, input.serverUrl);
	const user = await rpcClient.auth.me.query();
	const vaults = await rpcClient.vault.list.query();

	return { user, vaults };
}
