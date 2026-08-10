import { m } from "@bittery/i18n/paraglide/messages";
import { ApiProvider } from "@bittery/shared/api";
import { createSessionRefreshingApiClient } from "@bittery/shared/api-session-refresh";
import { getOrCreateClientId } from "@bittery/sync";
import { toast } from "@bittery/ui";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { PendingLoader } from "./components/loader";
import { getServerUrl } from "./lib/auth-server";
import { forgetActiveSession, initializeStorage, storage } from "./lib/storage";
import "./index.css";

import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { I18nProvider } from "./providers/i18n-provider";
import { WebPlatformProvider } from "./providers/platform-provider";
import { SyncProvider } from "./providers/sync-provider";
import { routeTree } from "./routeTree.gen";

let isHandlingAuthError = false;

function isUnauthorizedApiError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		error.status === 401
	);
}

function handleUnauthorizedError() {
	if (isHandlingAuthError) return;

	// Don't handle unauthorized errors on public routes — avoids infinite reload loop
	// when sync or other background queries fire without a valid token
	if (window.location.pathname === "/login") return;

	isHandlingAuthError = true;

	queryClient.clear();

	// An expired session is a sign-out, so the quick-unlock offer in `session_data` goes too.
	forgetActiveSession()
		.then(() => {
			toast.error(m.toast_auth_session_expired());
			window.location.href = "/login";
		})
		// Without this reset one rejection pins the latch and every later 401 is dropped.
		.catch(() => {
			isHandlingAuthError = false;
		});
}

export const queryClient = new QueryClient({
	queryCache: new QueryCache({
		onError: (error) => {
			if (isUnauthorizedApiError(error)) {
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
			if (isUnauthorizedApiError(error)) {
				handleUnauthorizedError();
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
		return getOrCreateClientId(window.localStorage);
	} catch {
		return null;
	}
}

async function getApiClientId(): Promise<string> {
	return (await getSyncClientIdHeader()) ?? crypto.randomUUID();
}

const apiClient = createSessionRefreshingApiClient({
	defaultServerUrl: getServerUrl(),
	getServerUrl: async () => getServerUrl(),
	getSessionSnapshot: async () => {
		await initializeStorage();
		const [token, sessionData] = await Promise.all([
			storage.getAuthToken(),
			storage.getStoredSessionData(),
		]);
		return {
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.serverExpiresAt ?? sessionData?.expiresAt ?? null,
		};
	},
	getRefreshToken: async () => {
		await initializeStorage();
		return storage.getAuthToken();
	},
	storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
		await initializeStorage();
		const accountId = await storage.getActiveAccount();
		if (!accountId) return;
		await storage.storeAuthToken(token, accountId);
		await storage.updateStoredSessionMetadata(accountId, {
			sessionId,
			expiresAt,
		});
	},
	getClientId: getApiClientId,
	clientPlatform: "web",
	clientVersion: import.meta.env.VITE_APP_VERSION ?? "0.0.0",
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
						<SyncProvider queryClient={queryClient}>
							<WebPlatformProvider>{children}</WebPlatformProvider>
						</SyncProvider>
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
