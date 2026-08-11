import { describe, expect, test } from "bun:test";
import { resolveAuthBootstrapServerUrl } from "./auth-server";

describe("auth server bootstrap URL", () => {
	test("allows a remote HTTP URL so the user can complete its security ceremony", () => {
		expect(
			resolveAuthBootstrapServerUrl("http://server.example/custom/prefix"),
		).toBe("http://server.example/custom/prefix");
	});

	test("still rejects malformed server URLs", () => {
		expect(() => resolveAuthBootstrapServerUrl("ftp://server.example")).toThrow(
			"Configured server URL is invalid.",
		);
	});
});
