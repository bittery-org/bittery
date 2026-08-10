import { ApiProvider as SharedApiProvider } from "@bittery/shared/api";
import { createSessionRefreshingApiClient } from "@bittery/shared/api-session-refresh";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getOrCreateMobileSyncClientId } from "@/lib/sync-client-id";
import { storage } from "@/services/storage";

export { useApiClient } from "@bittery/shared/api";

interface ServerUrlContextValue {
	serverUrl: string | null;
	setServerUrl: (url: string) => void;
}

const ServerUrlContext = createContext<ServerUrlContextValue>({
	serverUrl: null,
	setServerUrl: () => {},
});

export function useServerUrl() {
	return useContext(ServerUrlContext);
}

const DEFAULT_SERVER_URL =
	normalizeServerUrl(process.env.EXPO_PUBLIC_SERVER_URL) ||
	"http://localhost:3000";

interface ApiProviderProps {
	children: ReactNode;
}

export function ApiProvider({ children }: ApiProviderProps) {
	const [serverUrl, setServerUrlState] = useState<string | null>(null);
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 60 * 1000,
						retry: 1,
					},
				},
			}),
	);

	const setServerUrl = (url: string) => {
		setServerUrlState(url);
	};

	useEffect(() => {
		async function loadServerUrl() {
			try {
				const storedUrl = await storage.getServerUrl();
				if (storedUrl) {
					setServerUrlState(storedUrl);
				} else {
					setServerUrlState(DEFAULT_SERVER_URL);
				}
			} catch (error) {
				console.error("Error loading server URL:", error);
				setServerUrlState(DEFAULT_SERVER_URL);
			}
		}

		void loadServerUrl();
	}, []);

	const apiClient = useMemo(
		() =>
			createSessionRefreshingApiClient({
				defaultServerUrl: serverUrl ?? DEFAULT_SERVER_URL,
				getServerUrl: async () =>
					(await storage.getServerUrl()) || DEFAULT_SERVER_URL,
				getSessionSnapshot: async () => {
					const [token, activeAccount] = await Promise.all([
						storage.getAuthToken(),
						storage.getActiveAccount(),
					]);

					const activeAccountId = activeAccount ?? undefined;
					const sessionData =
						await storage.getStoredSessionData(activeAccountId);

					return {
						token,
						issuedAt: sessionData?.createdAt ?? null,
						expiresAt: sessionData?.expiresAt ?? null,
					};
				},
				getRefreshToken: () => storage.getAuthToken(),
				storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
					await storage.storeAuthToken(token);
					const activeAccount = await storage.getActiveAccount();
					const activeAccountId = activeAccount ?? undefined;
					if (activeAccountId) {
						await storage.updateStoredSessionMetadata(activeAccountId, {
							sessionId,
							expiresAt,
						});
					}
				},
				getClientId: async () => getOrCreateMobileSyncClientId(),
				clientPlatform: "mobile",
				clientVersion: process.env.EXPO_PUBLIC_APP_VERSION ?? "0.0.0",
			}),
		[serverUrl],
	);

	return (
		<ServerUrlContext.Provider value={{ serverUrl, setServerUrl }}>
			<QueryClientProvider client={queryClient}>
				<SharedApiProvider apiClient={apiClient}>{children}</SharedApiProvider>
			</QueryClientProvider>
		</ServerUrlContext.Provider>
	);
}
