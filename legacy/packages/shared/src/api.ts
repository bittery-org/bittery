import type { ApiClient } from "@bittery/api-contract";
import {
	createContext,
	createElement,
	type PropsWithChildren,
	useContext,
} from "react";

const ApiClientContext = createContext<ApiClient | null>(null);

export interface ApiProviderProps extends PropsWithChildren {
	apiClient: ApiClient;
}

/**
 * The API facade owns query keys and fetchers, avoiding a second transport-shaped
 * proxy that would leak generated operations back into application code.
 */
export function ApiProvider({ apiClient, children }: ApiProviderProps) {
	return createElement(
		ApiClientContext.Provider,
		{ value: apiClient },
		children,
	);
}

export function useApiClient(): ApiClient {
	const apiClient = useContext(ApiClientContext);
	if (!apiClient) {
		throw new Error("useApiClient must be used within ApiProvider");
	}
	return apiClient;
}
