import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { storage } from "@/lib/storage";

const fallbackServerUrl =
	normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
	"http://localhost:3000";

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

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async fetch(url, options) {
				const serverUrl = (await storage.getServerUrl()) ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);

				// Check if we're in "All Accounts" mode
				const activeEmail = await storage.getActiveAccountEmail();

				// Only get auth token if we have a real account (not "all" mode)
				const token = activeEmail && activeEmail !== "all"
					? await storage.getAuthToken()
					: null;

				const headers: Record<string, string> = {
					...(options?.headers as Record<string, string>),
				};

				// Only set Authorization header if we have a valid token
				if (token) {
					headers.Authorization = `Bearer ${token}`;
				}

				return fetch(resolvedUrl, {
					...options,
					credentials: "include",
					headers,
				});
			},
		}),
	],
});

const trpc = createTRPCOptionsProxy({
	client: trpcClient,
	queryClient: queryClient,
});

export { trpc, trpcClient, queryClient };
