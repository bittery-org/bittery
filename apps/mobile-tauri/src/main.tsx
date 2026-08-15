import "./styles.css";
import type { ApiClient } from "@bittery/api-contract";
import type { ClientRuntime } from "@bittery/core/services/client-runtime";
import { ApiProvider } from "@bittery/shared/api";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import { CredentialProviderSyncBridge } from "./components/credential-provider-sync-bridge";
import {
	AccountProvider,
	createMobileClientRuntime,
} from "./contexts/account-context";
import { installClipboardBridge } from "./lib/clipboard-bridge";
import { createMobileApiClient, queryClient } from "./lib/providers";
import { initializeStorage } from "./lib/storage";
import { I18nProvider } from "./providers/i18n-provider";
import { MobilePlatformProvider } from "./providers/platform-provider";
import { MobileSyncProvider } from "./providers/sync-provider";
// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
function createMobileRouter(apiClient: ApiClient, runtime: ClientRuntime) {
	return createRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreloadStaleTime: 0,
		context: { apiClient, queryClient, runtime },
	});
}

type MobileRouter = ReturnType<typeof createMobileRouter>;
let router: MobileRouter;

// Register the router instance for type safety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

async function initializeApp() {
	// Item-detail copy buttons (`@bittery/ui`) call `navigator.clipboard.writeText` directly —
	// install the fallback before any screen can render a copy button. See clipboard-bridge.ts.
	installClipboardBridge();

	// Initialize storage adapter (loads Tauri plugins)
	await initializeStorage();
	const apiClient = await createMobileApiClient();
	const runtime = createMobileClientRuntime(queryClient);
	await runtime.accounts.initialize();
	router = createMobileRouter(apiClient, runtime);

	ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<ThemeProvider
				attribute="class"
				defaultTheme="system"
				enableSystem
				disableTransitionOnChange
			>
				<I18nProvider>
					<QueryClientProvider client={queryClient}>
						<ApiProvider apiClient={apiClient}>
							<AccountProvider router={router} runtime={runtime}>
								<MobileSyncProvider queryClient={queryClient}>
									<MobilePlatformProvider>
										<CredentialProviderSyncBridge />
										<RouterProvider router={router} />
									</MobilePlatformProvider>
								</MobileSyncProvider>
							</AccountProvider>
						</ApiProvider>
					</QueryClientProvider>
				</I18nProvider>
			</ThemeProvider>
		</React.StrictMode>,
	);
}

initializeApp();
