import { createAppRpcOptionsProxy } from "@bittery/shared/rpc-client";
import { createSessionRefreshingRpcClient } from "@bittery/shared/rpc-session-refresh";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { resolveActiveAuthServerUrl } from "@/lib/auth-server";
import {
	handleDesktopUnauthorizedError,
	isUnauthorizedRpcError,
} from "@/lib/session-invalidation";
import { storage } from "@/lib/storage";
import { getOrCreateDesktopSyncClientId } from "@/lib/sync-client-id";

const fallbackServerUrl =
	normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
	"http://localhost:3000";

let isHandlingAuthError = false;

function isUnauthorizedError(error: unknown): boolean {
	return isUnauthorizedRpcError(error);
}

function handleUnauthorizedError(error: unknown) {
	if (isHandlingAuthError) return;

	const path = window.location.pathname;
	if (path === "/login" || path === "/unlock") return;

	isHandlingAuthError = true;

	void handleDesktopUnauthorizedError(error).then(
		({ prefillEmail, shouldRedirect }) => {
			if (!shouldRedirect) {
				isHandlingAuthError = false;
				return;
			}

			queryClient.clear();
			toast.error("Session expired. Please sign in again.");
			if (prefillEmail) {
				window.location.href = `/login?prefillEmail=${encodeURIComponent(prefillEmail)}`;
			} else {
				window.location.href = "/";
			}
		},
	);
}

const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			if (isUnauthorizedError(error)) {
				handleUnauthorizedError(error);
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
				handleUnauthorizedError(error);
			}
		},
	}),
	defaultOptions: { queries: { staleTime: 60 * 1000 } },
});

async function resolveDesktopServerUrl(): Promise<string> {
	const activeAccount = await storage.getActiveAccount();
	const accountServerUrl =
		activeAccount?.type === "single"
			? await storage.getServerUrl(activeAccount.accountId)
			: null;
	const activeAuthServerUrl = await resolveActiveAuthServerUrl();
	return (
		normalizeServerUrl(accountServerUrl ?? "") ??
		activeAuthServerUrl ??
		fallbackServerUrl
	);
}

const rpcClient = createSessionRefreshingRpcClient({
	defaultServerUrl: fallbackServerUrl,
	getServerUrl: resolveDesktopServerUrl,
	appPlatform: "desktop",
	getSessionSnapshot: async () => {
		const activeAccount = await storage.getActiveAccount();
		if (activeAccount?.type !== "single") {
			return { token: null, issuedAt: null, expiresAt: null };
		}

		const [token, sessionData] = await Promise.all([
			storage.getAuthToken(activeAccount.accountId),
			storage.getStoredSessionData(activeAccount.accountId),
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
		return storage.getAuthToken(activeAccount.accountId);
	},
	storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
		const activeAccount = await storage.getActiveAccount();
		if (activeAccount?.type === "single") {
			await storage.storeAuthToken(token, activeAccount.accountId);
			await storage.updateStoredSessionMetadata?.(activeAccount.accountId, {
				sessionId,
				expiresAt,
			});
		}
	},
	getClientId: async () => getOrCreateDesktopSyncClientId(),
});

const rpc = createAppRpcOptionsProxy(rpcClient, queryClient);

export { rpc, rpcClient, queryClient };
