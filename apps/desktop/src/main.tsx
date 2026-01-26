import "./styles.css";
import { TRPCProvider } from "@bittery/shared/trpc";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { AccountProvider } from "./contexts/account-context";
import { queryClient, trpc, trpcClient } from "./lib/providers";
import { initializeStorage } from "./lib/storage";
import { DesktopPlatformProvider } from "./providers/platform-provider";
import { DesktopSyncProvider } from "./providers/sync-provider";
// Import the generated route tree
import { routeTree } from "./routeTree.gen";

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

async function initializeApp() {
	// Initialize storage adapter (loads Tauri plugins)
	await initializeStorage();

	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<QueryClientProvider client={queryClient}>
				{/* @ts-ignore */}
				<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
					<DesktopPlatformProvider>
						<DesktopSyncProvider queryClient={queryClient}>
							<AccountProvider>
								<RouterProvider router={router} />
							</AccountProvider>
						</DesktopSyncProvider>
					</DesktopPlatformProvider>
				</TRPCProvider>
			</QueryClientProvider>
		</React.StrictMode>,
	);
}

initializeApp();
