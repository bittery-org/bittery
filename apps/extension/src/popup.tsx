import "./index.css";
import { createApiClient } from "@bittery/api-contract";
import { ApiProvider } from "@bittery/shared/api";
import { normalizeServerUrl } from "@bittery/shared/server-url";
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
import { sendMessage } from "./lib/messaging";
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

async function resolveServerRequest(request: Request): Promise<Response> {
	const snapshot = await sendMessage({ type: "GET_AUTH_TOKEN" });
	const token = snapshot.success ? snapshot.token : null;
	const serverUrl = normalizeServerUrl(
		(snapshot.success ? snapshot.serverUrl : null) ?? fallbackServerUrl,
	);
	if (!serverUrl) {
		throw new TypeError(
			"Account server URL is invalid or remote HTTP transport is not authorized.",
		);
	}
	const server = new URL(serverUrl);
	const target = new URL(request.url);
	const serverPath = server.pathname.replace(/\/$/, "");
	target.protocol = server.protocol;
	target.host = server.host;
	target.pathname = `${serverPath}${target.pathname}`;
	const headers = new Headers(request.headers);
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	} else {
		headers.delete("Authorization");
	}
	return fetch(new Request(target, request), { headers });
}

const apiClient = createApiClient({
	serverUrl: fallbackServerUrl,
	supportedApiMajors: [1],
	getClientMetadata: async () => {
		const response = await sendMessage({ type: "GET_SYNC_CLIENT_ID" });
		return {
			id: (response.success ? response.clientId : "") || "extension_popup",
			platform: "extension",
			version: chrome.runtime.getManifest().version,
		};
	},
	fetch: resolveServerRequest,
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
		<QueryClientProvider client={queryClient}>
			<ApiProvider apiClient={apiClient}>
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
			</ApiProvider>
		</QueryClientProvider>
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
