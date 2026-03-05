import { normalizeServerUrl } from "@bittery/shared/server-url";
import {
	createAppTrpcOptionsProxy,
} from "@bittery/shared/trpc-client";
import { createSessionRefreshingTrpcClient } from "@bittery/shared/trpc-session-refresh";
import { toast } from "@bittery/ui";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
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

async function resolveDesktopServerUrl(): Promise<string> {
	const activeAccount = await storage.getActiveAccount();
	const accountServerUrl =
		activeAccount?.type === "single"
			? await storage.getServerUrl(activeAccount.email)
			: null;
	const activeAuthServerUrl = await resolveActiveAuthServerUrl();
	return (
		normalizeServerUrl(accountServerUrl ?? "") ??
		activeAuthServerUrl ??
		fallbackServerUrl
	);
}

const trpcClient = createSessionRefreshingTrpcClient({
	defaultServerUrl: fallbackServerUrl,
	getServerUrl: resolveDesktopServerUrl,
	appPlatform: "desktop",
	getSessionSnapshot: async () => {
		const activeAccount = await storage.getActiveAccount();
		if (activeAccount?.type !== "single") {
			return { token: null, issuedAt: null, expiresAt: null };
		}

		const [token, sessionData] = await Promise.all([
			storage.getAuthToken(activeAccount.email),
			storage.getStoredSessionData(activeAccount.email),
		]);

		return {
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.expiresAt ?? null,
		};
	},
	getRefreshToken: async () => {
		const activeAccount = await storage.getActiveAccount();
		if (activeAccount?.type !== "single") {
			return null;
		}
		return storage.getAuthToken(activeAccount.email);
	},
	storeRefreshedToken: async (token) => {
		const activeAccount = await storage.getActiveAccount();
		if (activeAccount?.type === "single") {
			await storage.storeAuthToken(token, activeAccount.email);
		}
	},
	getClientId: async () => getOrCreateDesktopSyncClientId(),
});

const trpc = createAppTrpcOptionsProxy(trpcClient, queryClient);

export { trpc, trpcClient, queryClient };
