import { afterEach, describe, expect, it } from "bun:test";
import {
	accountMetadata,
	createTestAccountStore,
} from "../testing/account-store-harness";
import { createStoredAccountUnlockApiClient } from "./api-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("stored Account Quick Unlock client", () => {
	it("fails closed when the Account has no stored Server URL", async () => {
		const { store } = await createTestAccountStore();
		await store.addAccount(
			accountMetadata({ accountId: "account-a", serverUrl: "" }),
		);

		await expect(
			createStoredAccountUnlockApiClient(store, "account-a"),
		).rejects.toThrow("stored Server URL");
	});

	it("dispatches to the selected Account's custom Server with its HTTP consent", async () => {
		const { store } = await createTestAccountStore();
		await store.addAccount(
			accountMetadata({
				accountId: "account-a",
				serverUrl: "https://default.example",
			}),
		);
		await store.addAccount(
			accountMetadata({
				accountId: "account-b",
				serverUrl: "http://custom.example:8080",
				insecureTransportConfirmed: true,
			}),
		);
		await store.storeServerUrl("https://default.example", "account-a");
		await store.storeServerUrl("http://custom.example:8080", "account-b");

		const requests: Request[] = [];
		globalThis.fetch = (async (
			request: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const normalized = new Request(request, init);
			requests.push(normalized);
			if (normalized.url.endsWith("/api/meta")) {
				return Response.json({ capabilities: ["insecure-http"] });
			}
			return new Response(
				JSON.stringify({ mode: "self-hosted", allowPublicSignup: false }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		const client = await createStoredAccountUnlockApiClient(store, "account-b");
		await client.auth.registrationStatus();

		expect(requests).toHaveLength(2);
		expect(requests[1]?.url).toBe(
			"http://custom.example:8080/api/v1/auth/registration-status",
		);
		expect(requests[1]?.headers.has("Authorization")).toBe(false);
	});
});
