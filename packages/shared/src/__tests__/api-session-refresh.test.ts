import { describe, expect, test } from "bun:test";
import { createSessionRefreshingApiClient } from "../api-session-refresh";

const NOW = Date.now();

function unauthorized() {
	return Response.json(
		{
			type: "https://bittery.com/problems/authentication-required",
			title: "Authentication required",
			status: 401,
			code: "AUTHENTICATION_REQUIRED",
		},
		{ status: 401, headers: { "Content-Type": "application/problem+json" } },
	);
}

function refreshedSession() {
	return Response.json({
		token: "account-a-refreshed",
		sessionId: "session-a",
		expiresAt: new Date(NOW + 60_000).toISOString(),
	});
}

function vaultKey(vaultId: string) {
	return {
		vaultId,
		vaultName: vaultId,
		vaultType: "personal" as const,
		encryptedVaultKey: `wrapped-${vaultId}`,
		role: "owner" as const,
	};
}

function createSwitchingClient(
	fetch: (request: Request) => Promise<Response>,
	options: {
		switchAfterSnapshot?: boolean;
		serverPath?: string;
	} = {},
) {
	const { switchAfterSnapshot = true, serverPath = "" } = options;
	let activeAccountId = "account-a";
	const storedFor: string[] = [];
	const client = createSessionRefreshingApiClient({
		defaultServerUrl: `https://a.example.test${serverPath}`,
		getAccountSnapshot: async () => {
			const accountId = activeAccountId;
			const snapshot = {
				accountId,
				serverUrl: `https://${accountId === "account-a" ? "a" : "b"}.example.test${serverPath}`,
				token: `${accountId}-token`,
				issuedAt: NOW,
				expiresAt: NOW + 60_000,
				insecureTransportConfirmed: false,
			};
			if (switchAfterSnapshot) activeAccountId = "account-b";
			return snapshot;
		},
		storeRefreshedSession: async (snapshot, session) => {
			storedFor.push(`${snapshot.accountId}:${session.token}`);
		},
		getClientId: async () => "client-1",
		clientPlatform: "desktop",
		clientVersion: "0.5.0",
		fetch,
	});
	return { client, storedFor };
}

describe("session-refreshing API client account isolation", () => {
	test("paged reauth keeps its newly issued token despite an expired stored session", async () => {
		const requests: Request[] = [];
		const client = createSessionRefreshingApiClient({
			defaultServerUrl: "https://a.example.test",
			getAccountSnapshot: async () => ({
				accountId: "account-a",
				serverUrl: "https://a.example.test",
				token: "expired-stored-token",
				issuedAt: NOW - 60_000,
				expiresAt: NOW - 1,
				insecureTransportConfirmed: false,
			}),
			storeRefreshedSession: async () => {},
			getClientId: async () => "client-1",
			clientPlatform: "desktop",
			clientVersion: "0.5.0",
			fetch: async (request) => {
				requests.push(request);
				return Response.json({
					items: [vaultKey("vault-2")],
					nextCursor: null,
					hasMore: false,
				});
			},
		});

		const result = await client.auth.drainVaultKeys("newly-issued-token", {
			items: [vaultKey("vault-1")],
			nextCursor: "page-2",
			hasMore: true,
		});

		expect(result.data.map((key) => key.vaultId)).toEqual([
			"vault-1",
			"vault-2",
		]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(
			"https://a.example.test/api/v1/users/me/vault-keys?cursor=page-2",
		);
		expect(requests[0]?.headers.get("Authorization")).toBe(
			"Bearer newly-issued-token",
		);
		expect(
			requests.filter((request) =>
				request.url.endsWith("/sessions/current/refresh"),
			),
		).toHaveLength(0);
	});

	test("paged reauth stays on its original server when the active account switches", async () => {
		let activeAccountId = "account-a";
		const requests: Request[] = [];
		const client = createSessionRefreshingApiClient({
			defaultServerUrl: "https://a.example.test",
			getAccountSnapshot: async () => ({
				accountId: activeAccountId,
				serverUrl:
					activeAccountId === "account-a"
						? "https://a.example.test"
						: "https://b.example.test",
				token: `${activeAccountId}-stored-token`,
				issuedAt: NOW,
				expiresAt: NOW + 60_000,
				insecureTransportConfirmed: false,
			}),
			storeRefreshedSession: async () => {},
			getClientId: async () => "client-1",
			clientPlatform: "desktop",
			clientVersion: "0.5.0",
			fetch: async (request) => {
				requests.push(request);
				return Response.json({ items: [], nextCursor: null, hasMore: false });
			},
		});
		activeAccountId = "account-b";

		await client.auth.drainVaultKeys("account-a-issued-token", {
			items: [],
			nextCursor: "page-2",
			hasMore: true,
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toStartWith("https://a.example.test/");
		expect(requests[0]?.headers.get("Authorization")).toBe(
			"Bearer account-a-issued-token",
		);
	});

	test("does not refresh or retry a rejected request-scoped bearer", async () => {
		const requests: Request[] = [];
		let storedSessions = 0;
		const client = createSessionRefreshingApiClient({
			defaultServerUrl: "https://a.example.test",
			getAccountSnapshot: async () => ({
				accountId: "account-a",
				serverUrl: "https://a.example.test",
				token: "stored-token",
				issuedAt: NOW - 60_000,
				expiresAt: NOW - 1,
				insecureTransportConfirmed: false,
			}),
			storeRefreshedSession: async () => {
				storedSessions += 1;
			},
			getClientId: async () => "client-1",
			clientPlatform: "desktop",
			clientVersion: "0.5.0",
			fetch: async (request) => {
				requests.push(request);
				return unauthorized();
			},
		});

		await expect(
			client.auth.drainVaultKeys("rejected-issued-token", {
				items: [],
				nextCursor: "page-2",
				hasMore: true,
			}),
		).rejects.toEqual(expect.objectContaining({ status: 401 }));
		expect(requests).toHaveLength(1);
		expect(requests[0]?.headers.get("Authorization")).toBe(
			"Bearer rejected-issued-token",
		);
		expect(storedSessions).toBe(0);
		expect(
			requests.filter((request) =>
				request.url.endsWith("/sessions/current/refresh"),
			),
		).toHaveLength(0);
	});

	test("keeps request-scoped bearers behind remote HTTP operator policy", async () => {
		const requests: Request[] = [];
		const client = createSessionRefreshingApiClient({
			defaultServerUrl: "http://a.example.test",
			getAccountSnapshot: async () => ({
				accountId: "account-a",
				serverUrl: "http://a.example.test",
				token: "stored-token",
				issuedAt: NOW,
				expiresAt: NOW + 60_000,
				insecureTransportConfirmed: true,
			}),
			storeRefreshedSession: async () => {},
			getClientId: async () => "client-1",
			clientPlatform: "desktop",
			clientVersion: "0.5.0",
			fetch: async (request) => {
				requests.push(request);
				return Response.json({ capabilities: [] });
			},
		});

		await expect(
			client.auth.drainVaultKeys("issued-token", {
				items: [],
				nextCursor: "page-2",
				hasMore: true,
			}),
		).rejects.toThrow("OPERATOR_DISABLED");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://a.example.test/api/meta");
		expect(requests[0]?.headers.get("Authorization")).toBeNull();
	});

	test("rechecks operator capability before subsequent bearer requests", async () => {
		let operatorEnabled = true;
		const authenticatedRequests: Request[] = [];
		const client = createSessionRefreshingApiClient({
			defaultServerUrl: "http://server.example",
			getAccountSnapshot: async () => ({
				accountId: "account-a",
				serverUrl: "http://server.example",
				token: "account-a-token",
				issuedAt: NOW,
				expiresAt: NOW + 60_000,
				insecureTransportConfirmed: true,
			}),
			storeRefreshedSession: async () => {},
			getClientId: async () => "client-1",
			clientPlatform: "desktop",
			clientVersion: "0.5.0",
			fetch: async (request) => {
				if (request.url === "http://server.example/api/meta") {
					expect(request.headers.get("Authorization")).toBeNull();
					return Response.json({
						capabilities: operatorEnabled ? ["insecure-http"] : [],
					});
				}
				authenticatedRequests.push(request);
				return Response.json({});
			},
		});

		await client.auth.me();
		operatorEnabled = false;
		await expect(client.auth.me()).rejects.toThrow("OPERATOR_DISABLED");
		expect(authenticatedRequests).toHaveLength(1);
		expect(authenticatedRequests[0]?.headers.get("Authorization")).toBe(
			"Bearer account-a-token",
		);
	});

	test("replays a rejected query once against its immutable account snapshot", async () => {
		const requests: Request[] = [];
		const { client, storedFor } = createSwitchingClient(async (request) => {
			requests.push(request);
			if (request.url.endsWith("/sessions/current/refresh")) {
				return refreshedSession();
			}
			return request.headers.get("Authorization") ===
				"Bearer account-a-refreshed"
				? Response.json({})
				: unauthorized();
		});

		await client.auth.me();

		expect(requests.map((request) => request.url)).toEqual([
			"https://a.example.test/api/v1/users/me",
			"https://a.example.test/api/v1/sessions/current/refresh",
			"https://a.example.test/api/v1/users/me",
		]);
		expect(
			requests.map((request) => request.headers.get("Authorization")),
		).toEqual([
			"Bearer account-a-token",
			"Bearer account-a-token",
			"Bearer account-a-refreshed",
		]);
		expect(storedFor).toEqual(["account-a:account-a-refreshed"]);
		expect(
			requests.filter((request) =>
				request.url.endsWith("/sessions/current/refresh"),
			),
		).toHaveLength(1);
	});

	test("replays a rejected mutation once without changing its body or guards", async () => {
		const requests: Request[] = [];
		const { client } = createSwitchingClient(async (request) => {
			requests.push(request.clone());
			if (request.url.endsWith("/sessions/current/refresh")) {
				return refreshedSession();
			}
			return request.headers.get("Authorization") ===
				"Bearer account-a-refreshed"
				? Response.json({ version: 2 })
				: unauthorized();
		});

		await client.items.update(
			"item-1",
			{ encryptedData: "ciphertext" },
			{ etag: '"1"', idempotencyKey: "mutation-1" },
		);

		const mutationRequests = requests.filter((request) =>
			request.url.endsWith("/items/item-1"),
		);
		expect(mutationRequests).toHaveLength(2);
		expect(mutationRequests.map((request) => request.method)).toEqual([
			"PATCH",
			"PATCH",
		]);
		expect(
			mutationRequests.map((request) => request.headers.get("If-Match")),
		).toEqual(['"1"', '"1"']);
		expect(
			mutationRequests.map((request) => request.headers.get("Idempotency-Key")),
		).toEqual(["mutation-1", "mutation-1"]);
		expect(
			await Promise.all(mutationRequests.map((request) => request.json())),
		).toEqual([
			{ encryptedData: "ciphertext" },
			{ encryptedData: "ciphertext" },
		]);
	});

	test("single-flights concurrent 401 refreshes and replays each request once", async () => {
		const requests: Request[] = [];
		let releaseRefresh: (() => void) | undefined;
		const refreshBarrier = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		const { client, storedFor } = createSwitchingClient(
			async (request) => {
				requests.push(request);
				if (request.url.endsWith("/sessions/current/refresh")) {
					await refreshBarrier;
					return refreshedSession();
				}
				return request.headers.get("Authorization") ===
					"Bearer account-a-refreshed"
					? Response.json(
							request.url.endsWith("/vaults")
								? { items: [], hasMore: false }
								: {},
						)
					: unauthorized();
			},
			{ switchAfterSnapshot: false },
		);

		const calls = Promise.all([client.auth.me(), client.vaults.list()]);
		await Promise.resolve();
		releaseRefresh?.();
		await calls;

		expect(
			requests.filter((request) =>
				request.url.endsWith("/sessions/current/refresh"),
			),
		).toHaveLength(1);
		expect(
			requests.filter(
				(request) =>
					request.headers.get("Authorization") === "Bearer account-a-refreshed",
			),
		).toHaveLength(2);
		expect(storedFor).toEqual(["account-a:account-a-refreshed"]);
	});

	test("preserves a configured server path and query while the active account switches", async () => {
		const requests: Request[] = [];
		const { client } = createSwitchingClient(
			async (request) => {
				requests.push(request);
				if (request.url.endsWith("/sessions/current/refresh")) {
					return refreshedSession();
				}
				return request.headers.get("Authorization") ===
					"Bearer account-a-refreshed"
					? Response.json({ events: [], hasMore: false })
					: unauthorized();
			},
			{ serverPath: "/custom/prefix" },
		);

		await client.audit.list({ actionGroup: "share", limit: 10 });

		expect(requests.map((request) => request.url)).toEqual([
			"https://a.example.test/custom/prefix/api/v1/audit-events?actionGroup=share&limit=10",
			"https://a.example.test/custom/prefix/api/v1/sessions/current/refresh",
			"https://a.example.test/custom/prefix/api/v1/audit-events?actionGroup=share&limit=10",
		]);
	});
});
