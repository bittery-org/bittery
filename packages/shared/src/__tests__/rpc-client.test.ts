import { describe, expect, test } from "bun:test";
import {
	createAppRpcClient,
	isUnauthorizedRpcError,
	RpcClientError,
} from "../rpc-client";

// The auth extractor rejects before the handler runs, so the server answers with
// a JSON-RPC protocol error rather than a `result.Err` envelope.
function unauthorizedProtocolErrorFetch(): typeof fetch {
	return (async (_url: RequestInfo | URL, options?: RequestInit) => {
		const payload = JSON.parse(String(options?.body)) as { id: number };
		return new Response(
			JSON.stringify({
				jsonrpc: "2.0",
				id: payload.id,
				error: {
					code: -32603,
					message: "Authentication required",
					data: { code: "UNAUTHORIZED" },
				},
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
}

describe("isUnauthorizedRpcError", () => {
	test("detects the string code under a numeric transport code", () => {
		const error = new RpcClientError("Authentication required", {
			code: -32603,
			data: { code: "UNAUTHORIZED" },
		});

		expect(isUnauthorizedRpcError(error)).toBe(true);
	});

	test("detects a handler envelope error", () => {
		const error = new RpcClientError("Authentication required", {
			code: "UNAUTHORIZED",
		});

		expect(isUnauthorizedRpcError(error)).toBe(true);
	});

	test("leaves an unrelated error undetected", () => {
		const error = new RpcClientError("Vault not found", {
			code: "NOT_FOUND",
		});

		expect(isUnauthorizedRpcError(error)).toBe(false);
	});

	test("detects an unauthorized JSON-RPC protocol error from the client", async () => {
		const client = createAppRpcClient({
			serverUrl: "http://localhost:3000",
			fetch: unauthorizedProtocolErrorFetch(),
		});

		const error = await client.auth.me.query().then(
			() => null,
			(caught: unknown) => caught,
		);

		expect(isUnauthorizedRpcError(error)).toBe(true);
		expect((error as Error).message).toBe("Authentication required");
	});
});
