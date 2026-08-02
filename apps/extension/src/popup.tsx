import "./index.css";
import { RpcProvider } from "@bittery/shared/rpc";
import { createAppRpcClient } from "@bittery/shared/rpc-client";
import { buildRpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { Toaster } from "@bittery/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { subscribeBackgroundPushes } from "./lib/background-events";
import { storage } from "./lib/storage";
import { applyEarlyTheme } from "./lib/theme";
import { I18nProvider } from "./providers/i18n-provider";
import { ExtensionPlatformProvider } from "./providers/platform-provider";
import { ExtensionSyncProvider } from "./providers/sync-provider";
import { ThemeProvider } from "./providers/theme-provider";
import { routeTree } from "./routeTree";

// Apply the stored theme synchronously, before React renders, so the popup
// never flashes the wrong theme on open.
applyEarlyTheme();

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

// Create RPC client that communicates via background worker.
const rpcClient = createAppRpcClient({
	serverUrl: fallbackServerUrl,
	async headers() {
		// Get auth token and sync client id from background.
		const [authResponse, clientIdResponse] = await Promise.all([
			chrome.runtime.sendMessage({
				type: "GET_AUTH_TOKEN",
			}),
			chrome.runtime.sendMessage({
				type: "GET_SYNC_CLIENT_ID",
			}),
		]);
		return {
			authorization: authResponse.token ? `Bearer ${authResponse.token}` : "",
			"X-Client-Id": clientIdResponse.clientId || "",
		};
	},
	async fetch(url, options) {
		const storedServerUrl = await storage.getServerUrl();
		const serverUrl = storedServerUrl ?? fallbackServerUrl;
		const resolvedUrl = buildRpcUrl(serverUrl, url as string);
		return fetch(resolvedUrl, options);
	},
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

subscribeBackgroundPushes(queryClient, router);

function Popup() {
	return (
		<RpcProvider rpcClient={rpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<I18nProvider>
					<ThemeProvider>
						<ExtensionSyncProvider queryClient={queryClient}>
							<ExtensionPlatformProvider>
								<RouterProvider router={router} />
								<Toaster />
							</ExtensionPlatformProvider>
						</ExtensionSyncProvider>
					</ThemeProvider>
				</I18nProvider>
			</QueryClientProvider>
		</RpcProvider>
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
