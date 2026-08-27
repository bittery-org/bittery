import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { CryptoPort } from "@bittery/crypto-port";
import type { BiometricPort, PlatformPort, RecordPort } from "@bittery/storage";

class MemoryStorage implements Storage {
	readonly #values = new Map<string, string>();

	get length(): number {
		return this.#values.size;
	}

	clear(): void {
		this.#values.clear();
	}

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, String(value));
	}
}

const local = new MemoryStorage();
const session = new MemoryStorage();

const biometric: BiometricPort = {
	isAvailable: async () => false,
	getDetails: async () => ({ hasHardware: false, isEnrolled: false }),
	getType: async () => null,
	authenticate: async () => ({ success: false, error: "not_available" }),
};

function createPlatformPort(): PlatformPort {
	return {
		platform: "web",
		sessionSurvivesRestart: false,
		tiers: ["secret", "plain"],
		secretBacking: "test localStorage",
		recordKeyPrefix: "",
		biometric,
		initialize: async () => undefined,
		secretGet: async (key) => local.getItem(key),
		secretSet: async (key, value) => local.setItem(key, value),
		secretDelete: async (key) => local.removeItem(key),
		kvGet: async (key, scope) =>
			(scope === "session" ? session : local).getItem(key),
		kvSet: async (key, value, scope) =>
			(scope === "session" ? session : local).setItem(key, value),
		kvDelete: async (key, scope) =>
			(scope === "session" ? session : local).removeItem(key),
		kvListKeys: async (prefix) =>
			[...new Set([...keys(local), ...keys(session)])]
				.filter((key) => key.startsWith(prefix))
				.sort(),
	};
}

function keys(storage: Storage): string[] {
	return Array.from({ length: storage.length }, (_, index) =>
		storage.key(index),
	).filter((key): key is string => key !== null);
}

function createRecordPort(): RecordPort {
	return {
		recordKeyPrefix: "",
		initialize: async () => undefined,
		recordPut: async () => undefined,
		recordPutMany: async () => undefined,
		recordGet: async () => null,
		recordDelete: async () => undefined,
		recordList: async () => [],
		recordClear: async () => undefined,
	};
}

beforeAll(() => {
	Object.defineProperties(globalThis, {
		window: { configurable: true, value: {} },
		localStorage: { configurable: true, value: local },
		sessionStorage: { configurable: true, value: session },
	});
	mock.module("@bittery/storage/adapters/web", () => ({
		createWebPlatformPort: createPlatformPort,
		createWebRecordPort: createRecordPort,
	}));
	mock.module("./crypto", () => ({ crypto: {} as CryptoPort }));
	mock.module("./lifecycle", () => ({ lifecycleDeps: {} }));
});

async function importStorage(pageLoad: string) {
	return (await import(
		`${import.meta.dir}/storage.ts?${pageLoad}`
	)) as typeof import("./storage");
}

describe("initializeStorage", () => {
	test("preserves an existing active Account pointer", async () => {
		local.clear();
		session.clear();
		local.setItem("bittery_active_account", "active-account");

		const page = await importStorage("existing-active-account");
		await page.initializeStorage();

		expect(await page.storage.getActiveAccount()).toBe("active-account");
		expect(local.getItem("bittery_web_account_id")).toBeNull();
	});

	test("re-points an abandoned removal at the listed transitional Account", async () => {
		local.clear();
		session.clear();
		local.setItem(
			"bittery_accounts_list",
			JSON.stringify({
				version: 2,
				accounts: [
					{
						accountId: "login-account",
						email: "user@example.com",
						userId: "user-1",
						name: "User",
						serverUrl: "https://example.com",
						secretKeyHint: "A3-TEST",
						addedAt: 1,
						lastActiveAt: 2,
						biometricEnabled: false,
						insecureTransportConfirmed: false,
					},
					{
						accountId: "other-account",
						email: "other@example.com",
						userId: "user-2",
						name: "Other",
						serverUrl: "https://example.com",
						secretKeyHint: "A3-OTHER",
						addedAt: 2,
						lastActiveAt: 1,
						biometricEnabled: false,
						insecureTransportConfirmed: false,
					},
				],
			}),
		);

		const page = await importStorage("abandoned-removal");
		await page.initializeStorage();

		expect(await page.storage.getActiveAccount()).toBe("login-account");
		expect(local.getItem("bittery_web_account_id")).toBeNull();
	});

	test("mints and then reuses the synthetic id only for an empty Accounts list", async () => {
		local.clear();
		session.clear();

		const firstPage = await importStorage("fresh-browser");
		await firstPage.initializeStorage();
		const syntheticId = local.getItem("bittery_web_account_id");

		expect(syntheticId).not.toBeNull();
		expect(await firstPage.storage.getActiveAccount()).toBe(syntheticId);

		local.removeItem("bittery_active_account");
		const nextPage = await importStorage("fresh-browser-reload");
		await nextPage.initializeStorage();

		expect(local.getItem("bittery_web_account_id")).toBe(syntheticId);
		expect(await nextPage.storage.getActiveAccount()).toBe(syntheticId);
	});

	test("applies the seeding rule only once per page load", async () => {
		local.clear();
		session.clear();

		const page = await importStorage("memoized-page");
		await page.initializeStorage();
		const syntheticId = local.getItem("bittery_web_account_id");
		local.removeItem("bittery_active_account");
		local.setItem(
			"bittery_accounts_list",
			JSON.stringify({
				version: 2,
				accounts: [
					{
						accountId: "late-account",
						email: "late@example.com",
						userId: "late-user",
						name: "Late",
						serverUrl: "https://example.com",
						secretKeyHint: "A3-LATE",
						addedAt: 3,
						lastActiveAt: 4,
						biometricEnabled: false,
						insecureTransportConfirmed: false,
					},
				],
			}),
		);

		await page.initializeStorage();

		expect(await page.storage.getActiveAccount()).toBeNull();
		expect(local.getItem("bittery_web_account_id")).toBe(syntheticId);
	});

	test("is an SSR no-op without memoizing the browser initialization", async () => {
		local.clear();
		session.clear();
		Reflect.deleteProperty(globalThis, "window");
		try {
			const page = await importStorage("ssr-then-browser");
			await page.initializeStorage();

			expect(local.getItem("bittery_active_account")).toBeNull();
			expect(local.getItem("bittery_web_account_id")).toBeNull();

			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: {},
			});
			await page.initializeStorage();

			expect(await page.storage.getActiveAccount()).not.toBeNull();
			expect(local.getItem("bittery_web_account_id")).not.toBeNull();
		} finally {
			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: {},
			});
		}
	});
});
