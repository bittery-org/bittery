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

function resolveDefaultServerUrl(): string {
	const configured = process.env.EXPO_PUBLIC_SERVER_URL;
	if (!configured?.trim()) return "http://localhost:3000";
	const normalized = normalizeServerUrl(configured);
	if (normalized) return normalized;
	throw new TypeError(
		"Configured server URL is invalid or remote HTTP transport is not authorized.",
	);
}
const DEFAULT_SERVER_URL = resolveDefaultServerUrl();

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
				getAccountSnapshot: async () => {
					const activeAccount = await storage.getActiveAccount();
					if (!activeAccount) return null;
					const [token, sessionData, accountServerUrl, account] =
						await Promise.all([
							storage.getAuthToken(activeAccount),
							storage.getStoredSessionData(activeAccount),
							storage.getServerUrl(activeAccount),
							storage.getAccountMetadata(activeAccount),
						]);

					return {
						accountId: activeAccount,
						serverUrl: accountServerUrl || DEFAULT_SERVER_URL,
						token,
						issuedAt: sessionData?.createdAt ?? null,
						expiresAt: sessionData?.expiresAt ?? null,
						insecureTransportConfirmed:
							account?.insecureTransportConfirmed === true,
					};
				},
				storeRefreshedSession: async (
					snapshot,
					{ token, sessionId, expiresAt },
				) => {
					await storage.storeAuthToken(token, snapshot.accountId);
					await storage.updateStoredSessionMetadata(snapshot.accountId, {
						sessionId,
						expiresAt,
					});
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
