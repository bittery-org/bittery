import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { KdfParams } from "@bittery/types";
import { createWebStorageAdapter } from "./web";

const LEGACY_PIN_KEY = "bittery_pinned_kdf_params";

class MemoryStorage {
	private store = new Map<string, string>();
	getItem(key: string): string | null {
		return this.store.has(key) ? (this.store.get(key) as string) : null;
	}
	setItem(key: string, value: string): void {
		this.store.set(key, value);
	}
	removeItem(key: string): void {
		this.store.delete(key);
	}
	clear(): void {
		this.store.clear();
	}
}

const dummyCrypto = {} as Parameters<typeof createWebStorageAdapter>[0];

const params310k: KdfParams = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 310_000,
	salt: "acct-salt",
};

describe("web adapter pinned KDF params are per-account", () => {
	beforeEach(() => {
		const memory = new MemoryStorage();
		(globalThis as unknown as { window: unknown }).window = {};
		(globalThis as unknown as { localStorage: unknown }).localStorage = memory;
	});

	afterEach(() => {
		(globalThis as unknown as { window?: unknown }).window = undefined;
		(globalThis as unknown as { localStorage?: unknown }).localStorage =
			undefined;
	});

	it("returns the 310k pin stored for the active account, not the default", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);

		await storage.storePinnedKdfParams(params310k, "acct-a");

		expect(await storage.getPinnedKdfParams("acct-a")).toEqual(params310k);
	});

	it("isolates pins between accounts", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);

		await storage.storePinnedKdfParams(params310k, "acct-a");

		expect(await storage.getPinnedKdfParams("acct-b")).toBeNull();
	});

	it("falls back to a legacy shared pin when no per-account pin exists", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);
		(
			globalThis as unknown as { localStorage: MemoryStorage }
		).localStorage.setItem(LEGACY_PIN_KEY, JSON.stringify(params310k));

		expect(await storage.getPinnedKdfParams("acct-legacy")).toEqual(params310k);
	});
});
