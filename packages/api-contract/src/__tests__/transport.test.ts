import { describe, expect, test } from "bun:test";
import { createApiTransport } from "../transport.ts";

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
