import { describe, expect, test } from "bun:test";
import { normalizeServerUrl } from "../server-url";

const CONFIRMED_INSECURE_TRANSPORT = {
	operatorEnabled: true,
	accountConfirmed: true,
} as const;

describe("server transport policy", () => {
	test("allows HTTP loopback without an override", () => {
		expect(normalizeServerUrl("http://localhost:3000")).toBe(
			"http://localhost:3000",
		);
		expect(normalizeServerUrl("http://127.0.0.1:3000")).toBe(
			"http://127.0.0.1:3000",
		);
		expect(normalizeServerUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
	});

	test("requires both operator enablement and per-account confirmation for remote HTTP", () => {
		expect(normalizeServerUrl("http://192.0.2.10:3000")).toBeNull();
		expect(
			normalizeServerUrl("http://192.0.2.10:3000", {
				operatorEnabled: true,
				accountConfirmed: false,
			}),
		).toBeNull();
		expect(
			normalizeServerUrl("http://192.0.2.10:3000", {
				operatorEnabled: false,
				accountConfirmed: true,
			}),
		).toBeNull();
		expect(
			normalizeServerUrl(
				"http://192.0.2.10:3000",
				CONFIRMED_INSECURE_TRANSPORT,
			),
		).toBe("http://192.0.2.10:3000");
	});
});
