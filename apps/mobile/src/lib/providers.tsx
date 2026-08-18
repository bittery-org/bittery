import { isUnauthorizedApiError } from "@bittery/api-contract";
import { invalidateAccountSession } from "@bittery/core/services/account-lifecycle";
import { m } from "@bittery/i18n/paraglide/messages";
import { createSessionRefreshingApiClient } from "@bittery/shared/api-session-refresh";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { resolveActiveAuthServerUrl } from "@/lib/auth-server";
import { lifecycleDeps } from "@/lib/lifecycle";
import { storage } from "@/lib/storage";
import { getOrCreateMobileSyncClientId } from "@/lib/sync-client-id";

const discoveryPolicy = { operatorEnabled: true, accountConfirmed: true };

function resolveFallbackServerUrl(): string {
	const configured = import.meta.env.VITE_SERVER_URL;
	if (!configured?.trim()) return "http://localhost:3000";
	const normalized = normalizeServerUrl(configured, discoveryPolicy);
	if (normalized) return normalized;
	throw new TypeError(
		"Configured server URL is invalid or remote HTTP transport is not authorized.",
	);
}
const fallbackServerUrl = resolveFallbackServerUrl();

let isHandlingAuthError = false;

function handleUnauthorizedError() {
	if (isHandlingAuthError) return;

	const path = window.location.pathname;
	if (path === "/login" || path === "/unlock") return;

	isHandlingAuthError = true;

	void invalidateAccountSession("active", lifecycleDeps)
		.then((outcome) => {
			queryClient.clear();
			toast.error(m.toast_auth_session_expired());

			// A 401 with no active account still has to leave the screen that produced
			// it: staying put swallows the error and strands the user on a dead view.
			const prefillEmail = outcome.wasActive
				? outcome.affected[0]?.email
				: undefined;
			if (prefillEmail) {
				window.location.href = `/login?prefillEmail=${encodeURIComponent(prefillEmail)}`;
			} else {
				window.location.href = "/";
			}
		})
		.catch(() => {
			isHandlingAuthError = false;
		});
}

const queryClient = new QueryClient({
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

async function resolveMobileServerUrl(): Promise<string> {
	const activeAccount = await storage.getActiveAccount();
	const accountServerUrl = activeAccount
		? await storage.getServerUrl(activeAccount)
		: null;
	const activeAuthServerUrl = await resolveActiveAuthServerUrl();
	return (
		normalizeServerUrl(accountServerUrl ?? "", discoveryPolicy) ??
		activeAuthServerUrl ??
		fallbackServerUrl
	);
}

export async function createMobileApiClient() {
	const serverUrl = await resolveMobileServerUrl();
	return createSessionRefreshingApiClient({
		defaultServerUrl: serverUrl,
		clientPlatform: "mobile",
		clientVersion: import.meta.env.VITE_APP_VERSION ?? "0.0.0",
		getAccountSnapshot: async (originAccountId) => {
			const activeAccount =
				originAccountId ?? (await storage.getActiveAccount());
			if (!activeAccount) return null;

			const [token, sessionData, accountServerUrl, account] = await Promise.all(
				[
					storage.getAuthToken(activeAccount),
					storage.getStoredSessionData(activeAccount),
					storage.getServerUrl(activeAccount),
					storage.getAccountMetadata(activeAccount),
				],
			);
			const normalizedAccountServerUrl = accountServerUrl
				? normalizeServerUrl(accountServerUrl, {
						operatorEnabled: true,
						accountConfirmed: true,
					})
				: null;
			if (accountServerUrl && !normalizedAccountServerUrl) {
				throw new TypeError(
					"Account server URL is invalid or remote HTTP transport is not authorized.",
				);
			}

			return {
				accountId: activeAccount,
				serverUrl: normalizedAccountServerUrl ?? fallbackServerUrl,
				token,
				issuedAt: sessionData?.createdAt ?? null,
				expiresAt: sessionData?.expiresAt ?? null,
				insecureTransportConfirmed:
					account?.insecureTransportConfirmed === true,
			};
		},
		storeRefreshedSession: async (
			snapshot,
			{ token, sessionId, expiresAt },
		) => {
			await storage.storeAuthToken(token, snapshot.accountId);
			await storage.updateStoredSessionMetadata(snapshot.accountId, {
				sessionId,
				expiresAt,
			});
		},
		getClientId: async () => getOrCreateMobileSyncClientId(),
	});
}

export { queryClient };
