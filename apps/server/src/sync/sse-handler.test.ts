import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryPubSubAdapter } from "@bittery/pubsub";
import { closeRateLimitAdapterForTests } from "@bittery/rate-limit";
import { truncateAll } from "@bittery/test-utils";
import { createSyncRouter, isSyncConnectionRateLimited } from "./sse-handler";

describe("sync SSE handler", () => {
	afterEach(async () => {
		await truncateAll();
		await closeRateLimitAdapterForTests();
	});

	test("returns a minimal public health payload", async () => {
		const app = createSyncRouter(new InMemoryPubSubAdapter());
		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	test("rate limits repeated connection attempts for the same source IP", async () => {
		for (let i = 0; i < 20; i++) {
			expect(await isSyncConnectionRateLimited("198.51.100.55")).toBe(false);
		}

		expect(await isSyncConnectionRateLimited("198.51.100.55")).toBe(true);
	});
});
