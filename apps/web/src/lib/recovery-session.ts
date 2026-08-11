import { createAccountApiClient } from "@bittery/shared/api-client-factory";

export async function loadRecoveredAccountBootstrap(input: {
	token: string;
	serverUrl: string;
	insecureTransportConfirmed?: boolean;
}) {
	const apiClient = createAccountApiClient(
		input.token,
		input.serverUrl,
		undefined,
		undefined,
		{
			insecureTransportConfirmed: input.insecureTransportConfirmed === true,
			clientPlatform: "web",
		},
	);
	const [{ data: user }, { data: vaults }] = await Promise.all([
		apiClient.auth.me(),
		apiClient.vaults.list(),
	]);

	return { user, vaults };
}
