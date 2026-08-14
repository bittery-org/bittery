import "./styles.css";
import type { ApiClient } from "@bittery/api-contract";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { ApiProvider } from "@bittery/shared/api";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import {
	AccountProvider,
	createDesktopClientRuntime,
} from "./contexts/account-context";
import {
	initCreateItemIntentBridge,
	peekViewItemIntent,
} from "./lib/create-item-intent";
import { setupMacOSResetMenu } from "./lib/macos-reset-menu";
import { createDesktopApiClient, queryClient } from "./lib/providers";
import { initializeStorage } from "./lib/storage";
import { I18nProvider } from "./providers/i18n-provider";
import { DesktopPlatformProvider } from "./providers/platform-provider";
import { DesktopSyncProvider } from "./providers/sync-provider";
import { ThemeSync } from "./providers/theme-sync";
// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
function createDesktopRouter(apiClient: ApiClient, runtime: ClientRuntime) {
	return createRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
		context: { apiClient, queryClient, runtime },
	});
}

type DesktopRouter = ReturnType<typeof createDesktopRouter>;
let router: DesktopRouter;

// Register the router instance for type safety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

async function initializeApp() {
	// Initialize storage adapter (loads Tauri plugins)
	await initializeStorage();
	const apiClient = await createDesktopApiClient();
	const runtime = createDesktopClientRuntime(queryClient);
	await runtime.accounts.initialize();
	router = createDesktopRouter(apiClient, runtime);
	await setupMacOSResetMenu();
	await initCreateItemIntentBridge(() => {
		const viewIntent = peekViewItemIntent();
		if (viewIntent) {
			router.navigate({
				to: "/vault/$id/$itemId",
				params: { id: viewIntent.vaultId, itemId: viewIntent.itemId },
			});
			return;
		}
		router.navigate({ to: "/vault" });
	});

	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<ThemeProvider
				attribute="class"
				defaultTheme="system"
				enableSystem
				disableTransitionOnChange
			>
				<ThemeSync />
				<I18nProvider>
					<QueryClientProvider client={queryClient}>
						<ApiProvider apiClient={apiClient}>
							<AccountProvider router={router} runtime={runtime}>
								<DesktopSyncProvider queryClient={queryClient}>
									<DesktopPlatformProvider>
										<RouterProvider router={router} />
									</DesktopPlatformProvider>
								</DesktopSyncProvider>
							</AccountProvider>
						</ApiProvider>
					</QueryClientProvider>
				</I18nProvider>
			</ThemeProvider>
		</React.StrictMode>,
	);
}

initializeApp();
