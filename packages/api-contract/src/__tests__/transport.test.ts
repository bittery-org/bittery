import { describe, expect, test } from "bun:test";
import {
	ApiTransportError,
	createApiTransport,
	requestOriginHeaders,
} from "../transport.ts";

function streamResponse(): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.close();
			},
		}),
		{ status: 200 },
	);
}

function transportOptions() {
	return {
		baseUrl: "http://self-hosted.example/bittery",
		getAccessToken: () => "session-token",
		getClientMetadata: () => ({
			id: "client-1",
			platform: "desktop" as const,
			version: "0.5.1",
		}),
	};
}

describe("request transport", () => {
	// WebKit rejects uploads whose body became a stream, which is what
	// reconstructing a body-carrying Request does. Header injection and origin
	// extraction must leave the original request body intact.
	test("adds headers and strips the local origin while keeping the body", async () => {
		const seen: { body: string; origin: unknown; request: Request }[] = [];
		const transport = createApiTransport({
			...transportOptions(),
			insecureTransport: { operatorEnabled: true, accountConfirmed: true },
			fetch: async (request, requestOrigin) => {
				seen.push({
					body: await request.text(),
					origin: requestOrigin,
					request,
				});
				return Response.json({ ok: true });
			},
		});

		await transport.request("POST", "/api/v1/auth/email-checks", {
			body: { email: "test@example.com" },
			headers: requestOriginHeaders({
				kind: "persistedAccount",
				accountId: "account_1",
				serverUrl: "http://self-hosted.example/bittery",
			}),
		});

		const [call] = seen;
		expect(call?.origin).toEqual({
			kind: "persistedAccount",
			accountId: "account_1",
			serverUrl: "http://self-hosted.example/bittery",
		});
		expect(call?.body).toBe(JSON.stringify({ email: "test@example.com" }));
		expect(
			call?.request.headers.get("Bittery-Local-Request-Origin"),
		).toBeNull();
		expect(call?.request.headers.get("Bittery-Client-Id")).toBe("client-1");
		expect(call?.request.headers.get("Authorization")).toBe(
			"Bearer session-token",
		);
	});

	// A request that never reached the server has no problem document to read, and
	// `fetch` rejects with an engine-specific string - "Failed to fetch" in Chromium,
	// "Load failed" in WebKit. Callers surface `error.message`, so the raw rejection
	// would put browser internals in front of a user.
	test("normalizes a rejected fetch into a transport error", async () => {
		const transport = createApiTransport({
			...transportOptions(),
			insecureTransport: { operatorEnabled: true, accountConfirmed: true },
			fetch: async () => {
				throw new TypeError("Failed to fetch");
			},
		});

		const failure = await transport
			.request("GET", "/api/v1/vaults")
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiTransportError);
		expect((failure as ApiTransportError).message).not.toContain("fetch");
		expect((failure as ApiTransportError).cause).toBeInstanceOf(TypeError);
	});

	// A caller's fetch refuses requests of its own accord - a denied insecure
	// transport, an unusable server URL - and those are decisions, not failures.
	// Reporting one as an unreachable server would hide why the request never left.
	test("passes a refusal from the caller's own fetch through untouched", async () => {
		class TransportPolicyError extends Error {}
		const transport = createApiTransport({
			...transportOptions(),
			insecureTransport: { operatorEnabled: true, accountConfirmed: true },
			fetch: async () => {
				throw new TransportPolicyError("OPERATOR_DISABLED");
			},
		});

		const failure = await transport
			.request("GET", "/api/v1/vaults")
			.catch((error: unknown) => error);

		expect(failure).not.toBeInstanceOf(ApiTransportError);
		expect((failure as Error).message).toBe("OPERATOR_DISABLED");
	});

	// A cancelled query and a broken connection are not the same event: the sync
	// manager tells its own aborts apart by `name`, and wrapping one would turn a
	// deliberate disconnect into a reconnect loop.
	test("leaves a deliberate abort alone", async () => {
		const controller = new AbortController();
		const transport = createApiTransport({
			...transportOptions(),
			insecureTransport: { operatorEnabled: true, accountConfirmed: true },
			fetch: async () => {
				controller.abort();
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		});

		const failure = await transport
			.openSyncEvents(controller.signal)
			.catch((error: unknown) => error);

		expect(failure).not.toBeInstanceOf(ApiTransportError);
		expect((failure as Error).name).toBe("AbortError");
	});
});

describe("sync event transport", () => {
	test("does not send the bearer when remote HTTP lacks account confirmation", async () => {
		const requests: Request[] = [];
		const transport = createApiTransport({
			...transportOptions(),
			authorizeInsecureTransport: async () => ({
				operatorEnabled: true,
				accountConfirmed: false,
			}),
			fetch: async (request) => {
				requests.push(request);
				return streamResponse();
			},
		});

		await expect(transport.openSyncEvents()).rejects.toThrow(
			"Remote HTTP requires operator enablement and per-account confirmation.",
		);
		expect(requests).toEqual([]);
	});

	test("preserves a self-hosted base path after remote HTTP is authorized", async () => {
		const requests: Request[] = [];
		const authorizedServers: string[] = [];
		const transport = createApiTransport({
			...transportOptions(),
			authorizeInsecureTransport: async (serverUrl) => {
				authorizedServers.push(serverUrl);
				return { operatorEnabled: true, accountConfirmed: true };
			},
			fetch: async (request) => {
				requests.push(request);
				return streamResponse();
			},
		});

		await transport.openSyncEvents();

		expect(authorizedServers).toEqual(["http://self-hosted.example/bittery"]);
		expect(requests[0]?.url).toBe(
			"http://self-hosted.example/bittery/api/v1/sync/events",
		);
		expect(requests[0]?.headers.get("Authorization")).toBe(
			"Bearer session-token",
		);
	});

	test("blocks a later SSE reconnect when the operator revokes HTTP support", async () => {
		let operatorEnabled = true;
		const requests: Request[] = [];
		const transport = createApiTransport({
			...transportOptions(),
			authorizeInsecureTransport: async () => ({
				operatorEnabled,
				accountConfirmed: true,
			}),
			fetch: async (request) => {
				requests.push(request);
				return streamResponse();
			},
		});

		await transport.openSyncEvents();
		operatorEnabled = false;

		await expect(transport.openSyncEvents()).rejects.toThrow(
			"Remote HTTP requires operator enablement and per-account confirmation.",
		);
		expect(requests).toHaveLength(1);
	});
});
