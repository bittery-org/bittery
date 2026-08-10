import { createAccountApiClient } from "@bittery/shared/api-client-factory";

export async function loadRecoveredAccountBootstrap(input: {
	token: string;
	serverUrl: string;
}) {
	const apiClient = createAccountApiClient(input.token, input.serverUrl);
	const [{ data: user }, { data: vaults }] = await Promise.all([
		apiClient.auth.me(),
		apiClient.vaults.list(),
	]);

	return { user, vaults };
}
