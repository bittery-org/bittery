import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { storage } from "@/lib/storage";

const fallbackServerUrl =
	normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
	"http://localhost:3000";

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
	isHandlingAuthError = true;

	queryClient.clear();

	// Get active account email before clearing session so login page can prefill
	storage.getActiveAccount().then((activeAccount) => {
		const prefillEmail =
			activeAccount?.type === "single" ? activeAccount.email : undefined;

		storage.clearSession().then(() => {
			toast.error("Session expired. Please sign in again.");
			if (prefillEmail) {
				window.location.href = `/login?prefillEmail=${encodeURIComponent(prefillEmail)}`;
			} else {
				window.location.href = "/";
			}
		});
	});
}

const queryClient = new QueryClient({
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

const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async fetch(url, options) {
				const serverUrl = (await storage.getServerUrl()) ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);

				// Check if we're in "All Accounts" mode
				const activeAccount = await storage.getActiveAccount();

				// Only get auth token if we have a real account (not "all" mode)
				const token =
					activeAccount?.type === "single"
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
