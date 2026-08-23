import {
	isApiTransportError,
	isUnauthorizedApiError,
} from "@bittery/api-contract";
import { requireCompleteLifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import { m } from "@bittery/i18n/paraglide/messages";
import { ApiProvider } from "@bittery/shared/api";
import { createSessionRefreshingApiClient } from "@bittery/shared/api-session-refresh";
import { getOrCreateClientId } from "@bittery/sync";
import { toast } from "@bittery/ui";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { PendingLoader } from "./components/loader";
import { getServerUrl } from "./lib/auth-server";
import {
	initializeStorage,
	lockRejectedAccountSession,
	storage,
} from "./lib/storage";
import "./index.css";

import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { AccountRuntimeProvider } from "./providers/account-runtime-provider";
import { I18nProvider } from "./providers/i18n-provider";
import { WebPlatformProvider } from "./providers/platform-provider";
import { SyncProvider } from "./providers/sync-provider";
import { routeTree } from "./routeTree.gen";

let isHandlingAuthError = false;

function handleUnauthorizedError(originAccountId: string | null) {
	if (isHandlingAuthError) return;

	// Don't handle unauthorized errors on public routes — avoids infinite reload loop
	// when sync or other background queries fire without a valid token
	if (window.location.pathname === "/login") return;
	if (!originAccountId) {
		toast.error(m.toast_auth_session_lock_failed());
		return;
	}

	isHandlingAuthError = true;

	// A rejected Server Session requires online reauthentication, not a local Sign-out.
	// Keep Device-bound Quick Unlock inputs so the login route can ask only for a password.
	lockRejectedAccountSession(originAccountId)
		.then((outcome) =>
			requireCompleteLifecycleOutcome(outcome, {
				operation: "Web session reauthentication",
				requireAffected: true,
			}),
		)
		.then(() => {
			queryClient.clear();
			toast.error(m.toast_auth_session_expired());
			window.location.href = "/login";
		})
		// Without this reset one rejection pins the latch and every later 401 is dropped.
		.catch(() => {
			toast.error(m.toast_auth_session_lock_failed());
			isHandlingAuthError = false;
		});
}

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			if (isUnauthorizedApiError(error)) {
				return;
			}
			// An answered request carries the API's own problem detail, which is
			// written to be read. A request that never arrived carries nothing but
			// the engine's rejection, so the app supplies the copy instead.
			const message = isApiTransportError(error)
				? m.toast_api_unreachable()
				: error.message;
			toast.error(message, {
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
			if (isUnauthorizedApiError(error)) {
				return;
			}
		},
	}),
	defaultOptions: { queries: { staleTime: 60 * 1000 } },
});

async function getSyncClientIdHeader(): Promise<string | null> {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		return getOrCreateClientId(window.sessionStorage);
	} catch {
		return null;
	}
}

async function getApiClientId(): Promise<string> {
	return (await getSyncClientIdHeader()) ?? crypto.randomUUID();
}

const apiClient = createSessionRefreshingApiClient({
	defaultServerUrl: getServerUrl(),
	getAccountSnapshot: async (originAccountId) => {
		await initializeStorage();
		const accountId = originAccountId ?? (await storage.getActiveAccount());
		if (!accountId) return null;
		const [token, sessionData, serverUrl, account] = await Promise.all([
			storage.getAuthToken(accountId),
			storage.getStoredSessionData(accountId),
			storage.getServerUrl(accountId),
			storage.getAccountMetadata(accountId),
		]);
		return {
			accountId,
			serverUrl: serverUrl ?? getServerUrl(),
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.serverExpiresAt ?? sessionData?.expiresAt ?? null,
			insecureTransportConfirmed: account?.insecureTransportConfirmed === true,
		};
	},
	storeRefreshedSession: async (snapshot, { token, sessionId, expiresAt }) => {
		await storage.storeAuthToken(token, snapshot.accountId);
		await storage.updateStoredSessionMetadata(snapshot.accountId, {
			sessionId,
			expiresAt,
		});
	},
	getClientId: getApiClientId,
	clientPlatform: "web",
	clientVersion: import.meta.env.VITE_APP_VERSION ?? "0.0.0",
	onUnauthorized: handleUnauthorizedError,
});

export const getRouter = () => {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		scrollToTopSelectors: ["#auth-scroll-area", "#app-scroll-area"],
		defaultPreloadStaleTime: 0,
		defaultPendingMinMs: 350,
		context: { api: apiClient, queryClient },
		defaultPendingComponent: PendingLoader,
		defaultNotFoundComponent: () => <div>Not Found</div>,
		Wrap: ({ children }) => (
			<I18nProvider>
				<QueryClientProvider client={queryClient}>
					<ApiProvider apiClient={apiClient}>
						<AccountRuntimeProvider queryClient={queryClient}>
							<SyncProvider queryClient={queryClient}>
								<WebPlatformProvider>{children}</WebPlatformProvider>
							</SyncProvider>
						</AccountRuntimeProvider>
					</ApiProvider>
				</QueryClientProvider>
			</I18nProvider>
		),
	});
	return router;
};

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
