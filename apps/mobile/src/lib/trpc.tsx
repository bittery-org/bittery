import { normalizeServerUrl } from "@bittery/shared/server-url";
import { TRPCProvider as SharedTRPCProvider } from "@bittery/shared/trpc";
import { createSessionRefreshingTrpcClient } from "@bittery/shared/trpc-session-refresh";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { Platform } from "react-native";
import { getOrCreateMobileSyncClientId } from "@/lib/sync-client-id";
import { storage } from "@/services/storage";

// Re-export the shared tRPC hooks for consistency
export { useTRPC, useTRPCClient } from "@bittery/shared/trpc";

// Server URL context for dynamic server URL support
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

// Get the default server URL from environment or use fallback
const DEFAULT_SERVER_URL =
	normalizeServerUrl(process.env.EXPO_PUBLIC_SERVER_URL) ||
	"http://localhost:3000";

interface TRPCProviderProps {
	children: ReactNode;
}

export function TRPCProvider({ children }: TRPCProviderProps) {
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

	// Load server URL from storage on mount
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
		loadServerUrl();
	}, []);

	const [trpcClient] = useState(() =>
		createSessionRefreshingTrpcClient({
			defaultServerUrl: DEFAULT_SERVER_URL,
			getServerUrl: async () =>
				(await storage.getServerUrl()) || DEFAULT_SERVER_URL,
			getSessionSnapshot: async () => {
				const [token, activeAccount] = await Promise.all([
					storage.getAuthToken(),
					storage.getActiveAccount(),
				]);

				const activeEmail =
					activeAccount?.type === "single" ? activeAccount.email : undefined;
				const sessionData = await storage.getStoredSessionData(activeEmail);

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
				const activeEmail =
					activeAccount?.type === "single"
						? activeAccount.email
						: undefined;
				if (activeEmail) {
					await storage.updateStoredSessionMetadata?.(activeEmail, {
						sessionId,
						expiresAt,
					});
				}
			},
			getClientId: async () => getOrCreateMobileSyncClientId(),
			appPlatform: Platform.OS,
		}),
	);

	return (
		<ServerUrlContext.Provider value={{ serverUrl, setServerUrl }}>
			<QueryClientProvider client={queryClient}>
				<SharedTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
					{children}
				</SharedTRPCProvider>
			</QueryClientProvider>
		</ServerUrlContext.Provider>
	);
}
