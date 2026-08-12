import {
	type ApiClient,
	type ApiClientOptions,
	ApiError,
	ApiTransportError,
	createApiClient,
	isApiErrorStatus,
	isApiTransportError,
	isUnauthorizedApiError,
} from "@bittery/api-contract";

export type AppApiClient = ApiClient;
export type CreateAppApiClientOptions = ApiClientOptions;

export {
	ApiError,
	ApiTransportError,
	createApiClient as createAppApiClient,
	isApiErrorStatus,
	isApiTransportError,
	isUnauthorizedApiError,
};
