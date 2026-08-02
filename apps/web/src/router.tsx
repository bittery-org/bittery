import { m } from "@bittery/i18n/paraglide/messages";
import { RpcProvider } from "@bittery/shared/rpc";
import {
	createAppRpcOptionsProxy,
	isUnauthorizedRpcError,
} from "@bittery/shared/rpc-client";
import { createSessionRefreshingRpcClient } from "@bittery/shared/rpc-session-refresh";
import { getOrCreateClientId } from "@bittery/sync";
import { toast } from "@bittery/ui";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { PendingLoader } from "./components/loader";
import { getServerUrl } from "./lib/auth-server";
import { forgetActiveSession, initializeStorage, storage } from "./lib/storage";
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
			if (isUnauthorizedRpcError(error)) {
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
			if (isUnauthorizedRpcError(error)) {
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

const rpcClient = createSessionRefreshingRpcClient({
	defaultServerUrl: getServerUrl(),
	// Resolve at request time — prerender evaluates defaultServerUrl without `window`.
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
		const accountId = (await storage.getActiveAccount())?.accountId;
		if (!accountId) {
			return;
		}
		await storage.storeAuthToken(token, accountId);
		await storage.updateStoredSessionMetadata(accountId, {
			sessionId,
			expiresAt,
		});
	},
	getClientId: getSyncClientIdHeader,
});

const rpc = createAppRpcOptionsProxy(rpcClient, queryClient);

export const getRouter = () => {
	const router = createTanStackRouter({
		routeTree,
		scrollRestoration: true,
		scrollToTopSelectors: ["#auth-scroll-area", "#app-scroll-area"],
		defaultPreloadStaleTime: 0,
		defaultPendingMinMs: 350,
		context: { rpc, queryClient },
		defaultPendingComponent: PendingLoader,
		defaultNotFoundComponent: () => <div>Not Found</div>,
		Wrap: ({ children }) => (
			<I18nProvider>
				<QueryClientProvider client={queryClient}>
					<RpcProvider rpcClient={rpcClient} queryClient={queryClient}>
						<SyncProvider queryClient={queryClient}>
							<WebPlatformProvider>{children}</WebPlatformProvider>
						</SyncProvider>
					</RpcProvider>
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
