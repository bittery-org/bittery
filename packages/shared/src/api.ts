import {
	createContext,
	createElement,
	type PropsWithChildren,
	useContext,
} from "react";
import type { AppApiClient } from "./api-client";

const ApiClientContext = createContext<AppApiClient | null>(null);

export interface ApiProviderProps extends PropsWithChildren {
	apiClient: AppApiClient;
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

export function useApiClient(): AppApiClient {
	const apiClient = useContext(ApiClientContext);
	if (!apiClient) {
		throw new Error("useApiClient must be used within ApiProvider");
	}
	return apiClient;
}
