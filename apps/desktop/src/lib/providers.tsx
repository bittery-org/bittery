import { buildTrpcUrl, normalizeServerUrl } from "@bittery/crypto";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import type { AppRouter } from "@bittery/api/routers/index";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "@bittery/ui";

const fallbackServerUrl =
  normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
  "http://localhost:3000";

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      toast.error(error.message, {
        action: {
          label: "retry",
          onClick: () => {
            queryClient.invalidateQueries();
          },
        },
      });
    },
  }),
  defaultOptions: { queries: { staleTime: 60 * 1000 } },
});

const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${fallbackServerUrl}/trpc`,
      async fetch(url, options) {
        const serverUrl =
          (await tauriStorage.getServerUrl()) ?? fallbackServerUrl;
        const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
        const token = await tauriStorage.getAuthToken();
        return fetch(resolvedUrl, {
          ...options,
          credentials: "include",
          headers: {
            Authorization: token ? `Bearer ${token}` : undefined,
            ...options?.headers,
          } as HeadersInit,
        });
      },
    }),
  ],
});

const trpc = createTRPCOptionsProxy({
  client: trpcClient,
  queryClient: queryClient,
});

export { trpc, trpcClient, queryClient };
