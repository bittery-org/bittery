import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { TRPCProvider as SharedTRPCProvider } from "@bittery/shared/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
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
		createTRPCClient<AppRouter>({
			links: [
				httpBatchLink({
					url: `${DEFAULT_SERVER_URL}/trpc`,
					async fetch(url, options) {
						// Use dynamic server URL if available
						const currentServerUrl =
							(await storage.getServerUrl()) || DEFAULT_SERVER_URL;
						const resolvedUrl = buildTrpcUrl(currentServerUrl, url as string);
						const authToken = await storage.getAuthToken();
						return fetch(resolvedUrl, {
							...options,
							credentials: "include",
							headers: {
								...options?.headers,
								Authorization: (authToken
									? `Bearer ${authToken}`
									: undefined) as any,
							},
						});
					},
				}),
			],
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
