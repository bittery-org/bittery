/**
 * tRPC Client Setup
 * Configured to work with Chrome storage for auth tokens and server URL
 */

import type { AppRouter } from "@bittery/api/routers/index";
import {
	buildTrpcUrl,
	chromeStorage,
	normalizeServerUrl,
} from "@bittery/crypto";
import { createTRPCClient, httpBatchLink } from "@trpc/client";

const fallbackServerUrl =
	normalizeServerUrl("http://localhost:3000") ?? "http://localhost:3000";

// tRPC client for API calls
export const trpcClient = createTRPCClient<AppRouter>({
	links: [
		httpBatchLink({
			url: `${fallbackServerUrl}/trpc`,
			async headers() {
				const token = await chromeStorage.getAuthToken();
				return {
					authorization: token ? `Bearer ${token}` : "",
				};
			},
			async fetch(url, options) {
				const storedServerUrl = await chromeStorage.getServerUrl();
				const serverUrl = storedServerUrl ?? fallbackServerUrl;
				const resolvedUrl = buildTrpcUrl(serverUrl, url as string);
				return fetch(resolvedUrl.toString(), options);
			},
		}),
	],
});
