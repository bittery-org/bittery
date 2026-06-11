import { afterEach, describe, expect, test } from "bun:test";
import { getServerUrl } from "./auth-server";

describe("getServerUrl", () => {
	const originalWindow = globalThis.window;

	afterEach(() => {
		if (originalWindow === undefined) {
			// @ts-expect-error test cleanup
			delete globalThis.window;
		} else {
			globalThis.window = originalWindow;
		}
	});

	test("uses the current page origin when VITE_SERVER_URL is unset", () => {
		// @ts-expect-error minimal window stub for tests
		globalThis.window = {
			location: { origin: "https://bittery.example.com" },
		};

		expect(getServerUrl()).toBe("https://bittery.example.com");
	});
});
