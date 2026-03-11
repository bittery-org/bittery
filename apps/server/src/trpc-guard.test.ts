import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	TRPC_JSON_BODY_LIMIT_BYTES,
	enforceTrpcRequestGuards,
} from "./trpc-guard";

function createTestApp() {
	const app = new Hono();
	app.use("/trpc/*", enforceTrpcRequestGuards);
	app.post("/trpc/test.mutation", async (c) => {
		const body = await c.req.json();
		return c.json(body);
	});
	return app;
}

describe("tRPC request guards", () => {
	test("rejects oversized JSON body with 413", async () => {
		const app = createTestApp();
		const oversizedBody = JSON.stringify({
			payload: "x".repeat(TRPC_JSON_BODY_LIMIT_BYTES + 1),
		});

		const response = await app.request("/trpc/test.mutation", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Content-Length": String(oversizedBody.length),
			},
			body: oversizedBody,
		});

		expect(response.status).toBe(413);
	});

	test("rejects invalid mutation content type", async () => {
		const app = createTestApp();

		const response = await app.request("/trpc/test.mutation", {
			method: "POST",
			headers: {
				"Content-Type": "text/plain",
			},
			body: "not-json",
		});

		expect(response.status).toBe(415);
	});
});
