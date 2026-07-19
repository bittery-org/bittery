import "./styles.css";
import { RpcProvider } from "@bittery/shared/rpc";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import React from "react";
import ReactDOM from "react-dom/client";
import { AccountProvider } from "./contexts/account-context";
import {
	initCreateItemIntentBridge,
	peekViewItemIntent,
} from "./lib/create-item-intent";
import { setupMacOSResetMenu } from "./lib/macos-reset-menu";
import { queryClient, rpc, rpcClient } from "./lib/providers";
import { initializeStorage } from "./lib/storage";
import { I18nProvider } from "./providers/i18n-provider";
import { DesktopPlatformProvider } from "./providers/platform-provider";
import { DesktopSyncProvider } from "./providers/sync-provider";
import { ThemeSync } from "./providers/theme-sync";
// Import the generated route tree
import { routeTree } from "./routeTree.gen";

// Create a new router instance
const router = createRouter({
	routeTree,
	scrollRestoration: true,
	defaultPreloadStaleTime: 0,
	context: { rpc, queryClient },
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
						<RpcProvider rpcClient={rpcClient} queryClient={queryClient}>
							<DesktopSyncProvider queryClient={queryClient}>
								<DesktopPlatformProvider>
									<AccountProvider router={router}>
										<RouterProvider router={router} />
									</AccountProvider>
								</DesktopPlatformProvider>
							</DesktopSyncProvider>
						</RpcProvider>
					</QueryClientProvider>
				</I18nProvider>
			</ThemeProvider>
		</React.StrictMode>,
	);
}

initializeApp();
