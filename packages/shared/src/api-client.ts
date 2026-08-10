import {
	type ApiClient,
	type ApiClientOptions,
	createApiClient,
} from "@bittery/api-contract";

export type AppApiClient = ApiClient;
export type CreateAppApiClientOptions = ApiClientOptions;

export { createApiClient as createAppApiClient };
