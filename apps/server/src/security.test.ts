import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { handleServerError, securityHeadersMiddleware } from "./security";

function createSecurityTestApp() {
	const app = new Hono();
	app.use("*", securityHeadersMiddleware);
	app.onError(handleServerError);
	app.get("/trpc/example", (c) => c.json({ ok: true }));
	app.get("/sync/example", (c) => c.json({ ok: true }));
	app.get("/cdn/image", (c) => {
		c.header("Cache-Control", "public, max-age=3600");
		return c.text("image");
	});
	app.get("/boom", () => {
		throw new Error("boom");
	});
	return app;
}

describe("security headers middleware", () => {
	test("sets hardened no-store headers on sensitive routes", async () => {
		const response = await createSecurityTestApp().request("/trpc/example");

		expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
		expect(response.headers.get("Pragma")).toBe("no-cache");
		expect(response.headers.get("Expires")).toBe("0");
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("X-XSS-Protection")).toBe("0");
	});

	test("preserves CDN cacheability", async () => {
		const response = await createSecurityTestApp().request("/cdn/image");

		expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
		expect(response.headers.get("X-Frame-Options")).toBeNull();
	});

	test("returns a generic 500 response", async () => {
		const response = await createSecurityTestApp().request("/boom");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "Internal Server Error",
		});
		expect(response.headers.get("Cache-Control")).toBeNull();
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
	});
});
