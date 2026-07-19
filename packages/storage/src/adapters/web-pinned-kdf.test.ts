import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { KdfProfile } from "@bittery/types";
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

const profile600k: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

describe("web adapter pinned KDF profiles are per-account", () => {
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

	it("returns the pin stored for the requested account", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);

		await storage.storePinnedKdfProfile(profile600k, "acct-a");

		expect(await storage.getPinnedKdfProfile("acct-a")).toEqual(profile600k);
	});

	it("isolates pins between accounts", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);

		await storage.storePinnedKdfProfile(profile600k, "acct-a");

		expect(await storage.getPinnedKdfProfile("acct-b")).toBeNull();
	});

	it("never returns the obsolete shared pin", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);
		(
			globalThis as unknown as { localStorage: MemoryStorage }
		).localStorage.setItem(LEGACY_PIN_KEY, JSON.stringify(profile600k));

		expect(await storage.getPinnedKdfProfile("acct-legacy")).toBeNull();
	});

	it("removes the obsolete shared pin on a scoped write", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);
		const localStorage = (
			globalThis as unknown as { localStorage: MemoryStorage }
		).localStorage;
		localStorage.setItem(LEGACY_PIN_KEY, JSON.stringify(profile600k));

		await storage.storePinnedKdfProfile(profile600k, "acct-a");

		expect(localStorage.getItem(LEGACY_PIN_KEY)).toBeNull();
	});

	it("fails safely when a scoped pin is malformed", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);
		(
			globalThis as unknown as { localStorage: MemoryStorage }
		).localStorage.setItem(`${LEGACY_PIN_KEY}_acct-a`, "not json");

		expect(await storage.getPinnedKdfProfile("acct-a")).toBeNull();
	});

	it("fails safely when a scoped pin violates KDF policy", async () => {
		const storage = createWebStorageAdapter(dummyCrypto);
		(
			globalThis as unknown as { localStorage: MemoryStorage }
		).localStorage.setItem(
			`${LEGACY_PIN_KEY}_acct-a`,
			JSON.stringify({
				schemaVersion: 1,
				algorithm: "PBKDF2-SHA256",
				iterations: 310_000,
			}),
		);

		expect(await storage.getPinnedKdfProfile("acct-a")).toBeNull();
	});
});
