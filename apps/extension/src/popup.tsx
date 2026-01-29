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
import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { storage } from "./lib/storage";
import { ExtensionPlatformProvider } from "./providers/platform-provider";
import { ExtensionSyncProvider } from "./providers/sync-provider";
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
	// Listen for desktop lock/unlock events
	useEffect(() => {
		const handleMessage = (message: {
			type: string;
			reason?: string;
			accounts?: string[];
		}) => {
			if (message.type === "DESKTOP_LOCKED") {
				console.log(
					"[Popup] Desktop locked, clearing cache and navigating to unlock",
				);
				// Clear all cached data
				queryClient.clear();
				// Navigate to unlock screen
				router.navigate({ to: "/unlock" });
			} else if (message.type === "DESKTOP_UNLOCKED") {
				console.log(
					"[Popup] Desktop unlocked, clearing cache and navigating to vault",
				);
				// Clear all cached data to fetch fresh
				queryClient.clear();
				// Navigate to vault screen
				router.navigate({ to: "/vault" });
			}
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, []);

	return (
		<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<ExtensionSyncProvider queryClient={queryClient}>
					<ExtensionPlatformProvider>
						<RouterProvider router={router} />
						<Toaster />
					</ExtensionPlatformProvider>
				</ExtensionSyncProvider>
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
