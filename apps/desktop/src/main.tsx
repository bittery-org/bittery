import "./styles.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { TRPCProvider } from "@bittery/shared/trpc";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@bittery/api/routers/index";
import { QueryClient, QueryCache } from "@tanstack/react-query";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { toast } from "@bittery/ui";
import * as tauriStorage from "@bittery/crypto/storage-tauri";

// Import the generated route tree
import { routeTree } from "./routeTree.gen";

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
      url: `${import.meta.env.VITE_SERVER_URL || "http://localhost:3000"}/trpc`,
      async fetch(url, options) {
        const token = await tauriStorage.getAuthToken();
        return fetch(url, {
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

// Create a new router instance
const router = createRouter({
  routeTree,
  scrollRestoration: true,
  defaultPreloadStaleTime: 0,
  context: { trpc, queryClient },
});

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
      </TRPCProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
