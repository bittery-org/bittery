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

function createSwitchingClient(
	fetch: (request: Request) => Promise<Response>,
	switchAfterSnapshot = true,
) {
	let activeAccountId = "account-a";
	const storedFor: string[] = [];
	const client = createSessionRefreshingApiClient({
		defaultServerUrl: "https://a.example.test",
		getAccountSnapshot: async () => {
			const accountId = activeAccountId;
			const snapshot = {
				accountId,
				serverUrl: `https://${accountId === "account-a" ? "a" : "b"}.example.test`,
				token: `${accountId}-token`,
				issuedAt: NOW,
				expiresAt: NOW + 60_000,
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
		const { client, storedFor } = createSwitchingClient(async (request) => {
			requests.push(request);
			if (request.url.endsWith("/sessions/current/refresh")) {
				await refreshBarrier;
				return refreshedSession();
			}
			return request.headers.get("Authorization") ===
				"Bearer account-a-refreshed"
				? Response.json({})
				: unauthorized();
		}, false);

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
});
