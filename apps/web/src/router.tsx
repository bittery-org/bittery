import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/crypto/server-url";
import { getAuthToken, getServerUrl } from "@bittery/crypto/session-storage";
import { TRPCProvider } from "@bittery/shared/trpc";
import { toast } from "@bittery/ui";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import Loader from "./components/loader";
import "./index.css";
import { initWasmCrypto } from "./lib/wasm-crypto";

// Initialize WASM crypto module at app startup
// This runs once and is safe to call multiple times
initWasmCrypto();
import {
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { SyncProvider } from "./providers/sync-provider";
import { routeTree } from "./routeTree.gen";

export const queryClient = new QueryClient({
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
	(typeof window !== "undefined"
		? window.location.origin
		: "http://localhost:3000");

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			fetch(url, options) {
				const serverUrl = getServerUrl() ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
				return fetch(resolvedUrl, {
					...options,
					credentials: "include",
					headers: {
						// @ts-expect-error need to fix types upstream
						Authorization: getAuthToken()
							? `Bearer ${getAuthToken()}`
							: undefined,
						...options?.headers,
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
		defaultPreloadStaleTime: 0,
		context: { trpc, queryClient },
		defaultPendingComponent: () => <Loader />,
		defaultNotFoundComponent: () => <div>Not Found</div>,
		Wrap: ({ children }) => (
			<QueryClientProvider client={queryClient}>
				<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
					<SyncProvider queryClient={queryClient}>{children}</SyncProvider>
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
