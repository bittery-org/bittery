import type { AppRouter } from "@bittery/api/routers/index";
import { buildTrpcUrl, normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { resolveActiveAuthServerUrl } from "@/lib/auth-server";
import {
	invalidateDesktopAccountSession,
	isUnauthorizedTrpcError,
} from "@/lib/session-invalidation";
import { storage } from "@/lib/storage";
import { getOrCreateDesktopSyncClientId } from "@/lib/sync-client-id";

const fallbackServerUrl =
	normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
	"http://localhost:3000";

let isHandlingAuthError = false;

function isUnauthorizedError(error: unknown): boolean {
	return isUnauthorizedTrpcError(error);
}

function handleUnauthorizedError() {
	if (isHandlingAuthError) return;

	// Don't handle unauthorized errors on public routes — avoids infinite reload loop
	// when sync or other background queries fire without a valid token
	const path = window.location.pathname;
	if (path === "/login" || path === "/unlock") return;

	isHandlingAuthError = true;

	queryClient.clear();

	// Get active account email before clearing session so login page can prefill
	storage.getActiveAccount().then(async (activeAccount) => {
		const prefillEmail =
			activeAccount?.type === "single" ? activeAccount.email : undefined;

		if (activeAccount?.type === "single") {
			await invalidateDesktopAccountSession(activeAccount.email);
		} else {
			// In all-accounts mode we cannot reliably determine the failing account
			// from generic query/mutation errors.
			await storage.lockAllAccounts?.();
		}

		toast.error("Session expired. Please sign in again.");
		if (prefillEmail) {
			window.location.href = `/login?prefillEmail=${encodeURIComponent(prefillEmail)}`;
		} else {
			window.location.href = "/";
		}
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
				// Check if we're in "All Accounts" mode
				const activeAccount = await storage.getActiveAccount();
				const accountServerUrl =
					activeAccount?.type === "single"
						? await storage.getServerUrl(activeAccount.email)
						: null;
				const activeAuthServerUrl = await resolveActiveAuthServerUrl();
				const serverUrl =
					normalizeServerUrl(accountServerUrl ?? "") ??
					activeAuthServerUrl ??
					fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);

				// Only get auth token if we have a real account (not "all" mode)
				const token =
					activeAccount?.type === "single"
						? await storage.getAuthToken(activeAccount.email)
						: null;

				const headers: Record<string, string> = {
					...(options?.headers as Record<string, string>),
				};
				const syncClientId = await getOrCreateDesktopSyncClientId();
				headers["X-Client-Id"] = syncClientId;

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
