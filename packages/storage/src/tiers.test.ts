import { describe, expect, it } from "bun:test";
import { ACCOUNT_VALUES, GLOBAL_VALUES } from "./keys";
import {
	createInMemoryPlatformPort,
	createInMemoryRecordPort,
} from "./testing/in-memory-port";
import {
	assertTiersHonoured,
	deriveScope,
	STORAGE_TIERS,
	type StorageClass,
	type StoredValueName,
} from "./tiers";
import type { Platform } from "./types";

/** Everything that is key material or a credential. None of it may be `plain`. */
const MUST_BE_SECRET: readonly StoredValueName[] = [
	"jwt_token",
	"vault_keys",
	"encrypted_private_key",
	"session_data",
	"device_key",
	"secret_key",
];

/** The truth table from the contract. Declared once per adapter in the real ports. */
const PLATFORM_SESSION_SURVIVES_RESTART: ReadonlyArray<[Platform, boolean]> = [
	["web", false],
	["extension", false],
	["desktop", true],
	["mobile", true],
];

describe("STORAGE_TIERS", () => {
	it("never puts vault_keys in a plain tier", () => {
		expect(STORAGE_TIERS.vault_keys.tier).toBe("secret");
	});

	it("keeps vault_keys session-bound so it dies with a browser session", () => {
		expect(STORAGE_TIERS.vault_keys.class).toBe("session-bound");
		expect(deriveScope(STORAGE_TIERS.vault_keys.class, false)).toBe("session");
	});

	it("classifies every credential and key blob as secret", () => {
		for (const name of MUST_BE_SECRET) {
			expect(STORAGE_TIERS[name].tier).toBe("secret");
		}
	});

	it("has no row for the plaintext master unlock key", () => {
		// The plaintext MUK is never persisted on any platform: it lives only in
		// AccountStore's in-memory cache. A row appearing here is a security regression.
		const names = Object.keys(STORAGE_TIERS);
		expect(names).not.toContain("master_unlock_key");
		expect(names.filter((name) => name.includes("master_unlock"))).toEqual([]);
	});

	it("does not classify anything by size — tier decides placement", () => {
		// Guards the deleted react-native "under 2000 bytes -> SecureStore" rule: a
		// ValueTier has exactly two fields and neither of them is a size.
		for (const value of Object.values(STORAGE_TIERS)) {
			expect(Object.keys(value).sort()).toEqual(["class", "tier"]);
		}
	});

	it("declares a tier for every global and per-account value name", () => {
		for (const name of [...GLOBAL_VALUES, ...ACCOUNT_VALUES]) {
			expect(STORAGE_TIERS[name]).toBeDefined();
		}
	});
});

describe("deriveScope", () => {
	it("sends session-bound values to session scope only where sessions die", () => {
		for (const [platform, survives] of PLATFORM_SESSION_SURVIVES_RESTART) {
			const expected = survives ? "device" : "session";
			expect(`${platform}:${deriveScope("session-bound", survives)}`).toBe(
				`${platform}:${expected}`,
			);
		}
	});

	it("always sends device-bound values to device scope", () => {
		for (const [platform, survives] of PLATFORM_SESSION_SURVIVES_RESTART) {
			expect(`${platform}:${deriveScope("device-bound", survives)}`).toBe(
				`${platform}:device`,
			);
		}
	});

	it("only ever returns session or device", () => {
		const classes: readonly StorageClass[] = ["session-bound", "device-bound"];
		for (const valueClass of classes) {
			for (const survives of [true, false]) {
				expect(["session", "device"]).toContain(
					deriveScope(valueClass, survives),
				);
			}
		}
	});
});

describe("assertTiersHonoured", () => {
	it("accepts a port that honours both tiers", () => {
		const port = createInMemoryPlatformPort();

		expect(() => assertTiersHonoured(port)).not.toThrow();
	});

	it("throws for a port that declares only the plain tier", () => {
		const port = createInMemoryPlatformPort({ tiers: ["plain"] });

		expect(() => assertTiersHonoured(port)).toThrow(/secret/);
	});

	it("throws for a port that declares only the secret tier", () => {
		expect(() =>
			assertTiersHonoured({ platform: "web", tiers: ["secret"] }),
		).toThrow(/plain/);
	});

	it("names the offending platform so startup failures are diagnosable", () => {
		expect(() =>
			assertTiersHonoured({ platform: "mobile", tiers: [] }),
		).toThrow(/mobile/);
	});
});

describe("in-memory platform port", () => {
	it("drops session-scope writes on restart and keeps device-scope writes", async () => {
		const port = createInMemoryPlatformPort();
		await port.kvSet("bittery_account_a_vault_keys", "ciphertext", "session");
		await port.kvSet("bittery_accounts_list", "[]", "device");

		port.simulateRestart();

		expect(
			await port.kvGet("bittery_account_a_vault_keys", "session"),
		).toBeNull();
		expect(await port.kvGet("bittery_accounts_list", "device")).toBe("[]");
	});

	it("returns null for missing keys and treats deleting an absent key as a no-op", async () => {
		const port = createInMemoryPlatformPort();

		expect(await port.secretGet("nope")).toBeNull();
		expect(await port.kvGet("nope", "device")).toBeNull();
		await port.secretDelete("nope");
		await port.kvDelete("nope", "device");
	});

	it("lists keys from both scopes by prefix", async () => {
		const port = createInMemoryPlatformPort();
		await port.kvSet("bittery_account_a_server_url", "https://a", "device");
		await port.kvSet("bittery_account_b_jwt_token", "t", "session");
		await port.kvSet("unrelated", "x", "device");

		expect(await port.kvListKeys("bittery_account_")).toEqual([
			"bittery_account_a_server_url",
			"bittery_account_b_jwt_token",
		]);
	});
});

describe("in-memory record port", () => {
	it("upserts one record with one write and survives restart", async () => {
		const port = createInMemoryRecordPort();
		await port.recordPut("acct:items", "item-1", "a");
		port.resetCalls();

		await port.recordPut("acct:items", "item-1", "b");
		port.simulateRestart();

		expect(port.calls.recordPut).toBe(1);
		expect(await port.recordGet("acct:items", "item-1")).toBe("b");
	});

	it("isolates collections on list and clear", async () => {
		const port = createInMemoryRecordPort();
		await port.recordPut("acct:items", "item-1", "a");
		await port.recordPut("acct:vaults", "vault-1", "v");

		await port.recordClear("acct:items");

		expect(await port.recordList("acct:items")).toEqual([]);
		expect(await port.recordList("acct:vaults")).toEqual([
			{ id: "vault-1", value: "v" },
		]);
	});
});
