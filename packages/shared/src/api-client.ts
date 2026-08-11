import {
	type ApiClient,
	type ApiClientOptions,
	ApiError,
	createApiClient,
	isApiErrorStatus,
	isUnauthorizedApiError,
} from "@bittery/api-contract";

export type AppApiClient = ApiClient;
export type CreateAppApiClientOptions = ApiClientOptions;

export {
	ApiError,
	createApiClient as createAppApiClient,
	isApiErrorStatus,
	isUnauthorizedApiError,
};
