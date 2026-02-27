import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl } from "@bittery/shared/server-url";
import { TRPCProvider } from "@bittery/shared/trpc";
import { getOrCreateClientId } from "@bittery/sync";
import { toast } from "@bittery/ui";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { PendingLoader } from "./components/loader";
import { getServerUrl } from "./lib/auth-server";
import { storage } from "./lib/storage";
import "./index.css";
import { initWasmCrypto } from "./lib/wasm-crypto";

// Initialize WASM crypto module at app startup
// This runs once and is safe to call multiple times
initWasmCrypto();

import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { WebPlatformProvider } from "./providers/platform-provider";
import { SyncProvider } from "./providers/sync-provider";
import { routeTree } from "./routeTree.gen";

let isHandlingAuthError = false;

function isUnauthorizedError(error: unknown): boolean {
	if (
		error &&
		typeof error === "object" &&
		"data" in error &&
		(error as any).data?.code === "UNAUTHORIZED"
	) {
		return true;
	}
	return false;
}

function handleUnauthorizedError() {
	if (isHandlingAuthError) return;

	// Don't handle unauthorized errors on public routes — avoids infinite reload loop
	// when sync or other background queries fire without a valid token
	if (window.location.pathname === "/login") return;

	isHandlingAuthError = true;

	queryClient.clear();

	storage.clearSession().then(() => {
		toast.error("Session expired. Please sign in again.");
		window.location.href = "/login";
	});
}

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			if (isUnauthorizedError(error)) {
				handleUnauthorizedError();
				return;
			}
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
	mutationCache: new MutationCache({
		onError: (error) => {
			if (isUnauthorizedError(error)) {
				handleUnauthorizedError();
			}
		},
	}),
	defaultOptions: { queries: { staleTime: 60 * 1000 } },
});

const serverUrl = getServerUrl();

function getSyncClientIdHeader(): string | null {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		return getOrCreateClientId(window.localStorage);
	} catch {
		return null;
	}
}

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${serverUrl}/trpc`,
			async fetch(url, options) {
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
				const authToken = await storage.getAuthToken();
				const syncClientId = getSyncClientIdHeader();
				return fetch(resolvedUrl, {
					...options,
					credentials: "include",
					headers: {
						...options?.headers,
						...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
						...(syncClientId ? { "X-Client-Id": syncClientId } : {}),
					},
				});
			},
		}),
	],
});

const trpc = createTRPCOptionsProxy({
	client: trpcClient,
	queryClient: queryClient,
});

export const getRouter = () => {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		scrollToTopSelectors: ["#auth-scroll-area", "#app-scroll-area"],
		defaultPreloadStaleTime: 0,
		defaultPendingMinMs: 350,
		context: { trpc, queryClient },
		defaultPendingComponent: PendingLoader,
		defaultNotFoundComponent: () => <div>Not Found</div>,
		Wrap: ({ children }) => (
			<QueryClientProvider client={queryClient}>
				<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
					<SyncProvider queryClient={queryClient}>
						<WebPlatformProvider>{children}</WebPlatformProvider>
					</SyncProvider>
				</TRPCProvider>
			</QueryClientProvider>
		),
	});
	return router;
};

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
