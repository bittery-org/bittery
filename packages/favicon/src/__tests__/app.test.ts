import { describe, expect, test } from "bun:test";
import { faviconApp } from "../app";

describe("faviconApp", () => {
	test("returns 404 for invalid domain input", async () => {
		const response = await faviconApp.request("/not a domain");
		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
	});
});
