import type { AppRouter } from "@bittery/api/routers/index";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { storage } from "@/services/storage";

// Create tRPC context and hooks using the newer pattern
export const {
  TRPCProvider: TRPCContextProvider,
  useTRPC,
  useTRPCClient,
} = createTRPCContext<AppRouter>();

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
  process.env.EXPO_PUBLIC_SERVER_URL || "http://localhost:3000";

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
          async headers() {
            try {
              const token = await storage.getAuthToken();
              if (token) {
                return {
                  Authorization: `Bearer ${token}`,
                };
              }
            } catch (error) {
              console.error("Error getting auth token:", error);
            }
            return {};
          },
          async fetch(url, options) {
            // Use dynamic server URL if available
            const baseUrl = serverUrl || DEFAULT_SERVER_URL;
            const resolvedUrl = (url as string).replace(
              `${DEFAULT_SERVER_URL}/trpc`,
              `${baseUrl}/trpc`,
            );
            return fetch(resolvedUrl, options);
          },
        }),
      ],
    }),
  );

  return (
    <ServerUrlContext.Provider value={{ serverUrl, setServerUrl }}>
      <TRPCContextProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </TRPCContextProvider>
    </ServerUrlContext.Provider>
  );
}
