import "./index.css";
import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { TRPCProvider } from "@bittery/shared/trpc";
import { Toaster } from "@bittery/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import React from "react";
import ReactDOM from "react-dom/client";
import { storage } from "./lib/storage";
import { routeTree } from "./routeTree";

// Create TanStack Query client
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			refetchOnWindowFocus: false,
		},
	},
});

const fallbackServerUrl =
	normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";

// Create tRPC client that communicates via background worker
const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async headers() {
				// Get auth token from chrome.storage via background
				const response = await chrome.runtime.sendMessage({
					type: "GET_AUTH_TOKEN",
				});
				return {
					authorization: response.token ? `Bearer ${response.token}` : "",
				};
			},
			async fetch(url, options) {
				const storedServerUrl = await storage.getServerUrl();
				const serverUrl = storedServerUrl ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
				return fetch(resolvedUrl, options);
			},
		}),
	],
});

// Create router with memory history (no URL bar in popup)
const memoryHistory = createMemoryHistory({
	initialEntries: ["/"],
});

const router = createRouter({
	routeTree,
	history: memoryHistory,
	context: {
		queryClient,
	},
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

function Popup() {
	return (
		<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
				<Toaster />
			</QueryClientProvider>
		</TRPCProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<Popup />
		</React.StrictMode>,
	);
}
