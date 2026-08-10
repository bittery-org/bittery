import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearAccountRpcClient,
	clearRpcClientCache,
	createAccountRpcClient,
	getDefaultServerUrl,
} from "../rpc-client-factory";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalServerUrl = process.env.VITE_SERVER_URL;

function setWindowOrigin(origin: string) {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			location: { origin },
		},
	});
}

function setWindowWithoutLocation() {
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {},
	});
}

function restoreWindow() {
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
		return;
	}

	Reflect.deleteProperty(globalThis, "window");
}

describe("rpc client factory", () => {
	beforeEach(() => {
		delete process.env.VITE_SERVER_URL;
	});

	afterEach(() => {
		clearRpcClientCache();
		if (originalServerUrl === undefined) {
			delete process.env.VITE_SERVER_URL;
		} else {
			process.env.VITE_SERVER_URL = originalServerUrl;
		}
		restoreWindow();
	});

	test("falls back to the browser origin when no server URL is configured", () => {
		setWindowOrigin("https://vault.example.com");

		expect(getDefaultServerUrl()).toBe("https://vault.example.com");
	});

	test("uses a configured server URL before the browser origin", () => {
		process.env.VITE_SERVER_URL = "https://api.example.com/rpc";
		setWindowOrigin("https://vault.example.com");

		expect(getDefaultServerUrl()).toBe("https://api.example.com");
	});

	test("falls back to localhost for non-HTTP browser origins", () => {
		setWindowOrigin("chrome-extension://extension-id");

		expect(getDefaultServerUrl()).toBe("http://localhost:3000");
	});

	test("falls back to localhost when the runtime window has no location", () => {
		setWindowWithoutLocation();

		expect(getDefaultServerUrl()).toBe("http://localhost:3000");
	});

	test("creates and clears account clients with omitted server URL", () => {
		setWindowOrigin("https://vault.example.com");

		const client = createAccountRpcClient("omitted-server-url-token");

		expect(
			createAccountRpcClient(
				"omitted-server-url-token",
				"https://vault.example.com",
			),
		).toBe(client);

		clearAccountRpcClient("omitted-server-url-token");

		expect(createAccountRpcClient("omitted-server-url-token")).not.toBe(client);
	});

	test("creates and clears account clients with null server URL", () => {
		setWindowOrigin("https://vault.example.com");

		const client = createAccountRpcClient("null-server-url-token", null);

		expect(
			createAccountRpcClient(
				"null-server-url-token",
				"https://vault.example.com",
			),
		).toBe(client);

		clearAccountRpcClient("null-server-url-token", null);

		expect(createAccountRpcClient("null-server-url-token", null)).not.toBe(
			client,
		);
	});
});
