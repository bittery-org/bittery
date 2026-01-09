import "./styles.css";
import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/crypto";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { TRPCProvider } from "@bittery/shared/trpc";
import { toast } from "@bittery/ui";
import {
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { AccountProvider } from "./contexts/account-context";

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

const fallbackServerUrl =
	normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
	"http://localhost:3000";

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async fetch(url, options) {
				const serverUrl =
					(await tauriStorage.getServerUrl()) ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url);
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

// Run migration before rendering
async function initializeApp() {
	try {
		await tauriStorage.migrateToMultiAccount();
	} catch (error) {
		console.error("[main] Migration failed:", error);
	}

	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<QueryClientProvider client={queryClient}>
				<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
					<AccountProvider>
						<RouterProvider router={router} />
					</AccountProvider>
				</TRPCProvider>
			</QueryClientProvider>
		</React.StrictMode>,
	);
}

initializeApp();
