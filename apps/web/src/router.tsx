import { TRPCProvider } from "@bittery/shared/trpc";
import { createAppTrpcOptionsProxy } from "@bittery/shared/trpc-client";
import { createSessionRefreshingTrpcClient } from "@bittery/shared/trpc-session-refresh";
import { getOrCreateClientId } from "@bittery/sync";
import { toast } from "@bittery/ui";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { PendingLoader } from "./components/loader";
import { getServerUrl } from "./lib/auth-server";
import { storage } from "./lib/storage";
import { m } from "@bittery/i18n/paraglide/messages";
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
import { I18nProvider } from "./providers/i18n-provider";
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
		toast.error(m.toast_auth_session_expired());
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

const trpcClient = createSessionRefreshingTrpcClient({
	defaultServerUrl: serverUrl,
	getServerUrl: async () => serverUrl,
	getSessionSnapshot: async () => {
		const [token, sessionData] = await Promise.all([
			storage.getAuthToken(),
			storage.getStoredSessionData?.() ?? Promise.resolve(null),
		]);
		return {
			token,
			issuedAt: sessionData?.createdAt ?? null,
			expiresAt: sessionData?.serverExpiresAt ?? sessionData?.expiresAt ?? null,
		};
	},
	getRefreshToken: () => storage.getAuthToken(),
	storeRefreshedSession: async ({ token, sessionId, expiresAt }) => {
		await storage.storeAuthToken(token);
		await storage.updateStoredSessionMetadata?.("", {
			sessionId,
			expiresAt,
		});
	},
	getClientId: getSyncClientIdHeader,
});

const trpc = createAppTrpcOptionsProxy(trpcClient, queryClient);

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
			<I18nProvider>
				<QueryClientProvider client={queryClient}>
					<TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
						<SyncProvider queryClient={queryClient}>
							<WebPlatformProvider>{children}</WebPlatformProvider>
						</SyncProvider>
					</TRPCProvider>
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
