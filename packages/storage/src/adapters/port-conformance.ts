/**
 * The shared port conformance suite.
 *
 * `PlatformPort` and `RecordPort` are the seams of this package: everything above them
 * (`AccountStore`, `ItemCache`) is tested once against the in-memory fakes, and everything
 * below them is a per-platform mapping. This file is one suite body, run four times, that
 * pins the behavioural contract every adapter must satisfy.
 *
 * Two rules keep it honest:
 *
 *   1. **Nothing here may import a platform API**, and nothing here may branch on `name`.
 *      `name` is a label for the test output, not a capability probe. The moment this file
 *      says `if (name === "web")` the suite has stopped being a contract.
 *   2. **Only port-visible behaviour is asserted.** Where the contract deliberately leaves
 *      an adapter free — e.g. whether `kvListKeys` also sees keys written through
 *      `secret*` (it does on web and chrome, which map both onto one store; it does not on
 *      tauri, whose secrets live in the OS keychain) — the suite says nothing.
 *
 * `make()` must hand back a **fresh, empty** pair on every call: the suite calls it once
 * per test and assumes no state carries over.
 */

import { describe, expect, test } from "bun:test";
import type { PlatformPort } from "../platform-port";
import type { RecordPort } from "../record-port";
import { assertTiersHonoured } from "../tiers";
import type { Platform } from "../types";

const VALID_PLATFORMS: readonly Platform[] = [
	"web",
	"extension",
	"desktop",
	"mobile",
];

/**
 * Comfortably over the ~2048-byte `expo-secure-store` limit on Android, so this value proves
 * that chunking inside the react-native adapter is invisible above the port.
 */
const LARGE_SECRET = "0123456789abcdef".repeat(512); // 8192 chars

const LARGE_RECORD = "record-payload-".repeat(600); // ~9000 chars

/** Multi-byte content, so a chunking adapter cannot split a value mid-codepoint. */
const UNICODE_VALUE = "héllo — wörld 🔐 ünïcøde ✓";

export interface ConformancePorts {
	platform: PlatformPort;
	record: RecordPort;
}

/**
 * Run the shared conformance suite against one adapter.
 *
 * @param name  Label for the test output only. Never branch on it.
 * @param make  Produces a fresh, initialised, empty port pair for a single test.
 */
export function runPortConformance(
	name: string,
	make: () => Promise<ConformancePorts>,
): void {
	describe(`${name} adapter — PlatformPort`, () => {
		test("declares coherent metadata", async () => {
			const { platform } = await make();

			expect(VALID_PLATFORMS).toContain(platform.platform);
			expect(typeof platform.sessionSurvivesRestart).toBe("boolean");
			expect(typeof platform.secretBacking).toBe("string");
			expect(platform.secretBacking.length).toBeGreaterThan(0);
			expect(platform.tiers.length).toBeGreaterThan(0);
			// Total, never optional: `AccountStore` concatenates it unconditionally into the
			// native-host projection. `""` is the honest answer where no native host reads
			// records, and the empty concatenation is exactly what that means.
			expect(typeof platform.recordKeyPrefix).toBe("string");
		});

		test("declares every tier STORAGE_TIERS demands", async () => {
			const { platform } = await make();

			// The startup guard that stops a port silently demoting secrets. If this
			// throws, the adapter is claiming less than the tier table requires.
			expect(() => assertTiersHonoured(platform)).not.toThrow();
			expect(platform.tiers).toContain("secret");
			expect(platform.tiers).toContain("plain");
		});

		test("exposes a total biometric port", async () => {
			const { platform } = await make();

			expect(typeof (await platform.biometric.isAvailable())).toBe("boolean");
			const details = await platform.biometric.getDetails();
			expect(typeof details.hasHardware).toBe("boolean");
			expect(typeof details.isEnrolled).toBe("boolean");
			const type = await platform.biometric.getType();
			expect(type === null || typeof type === "string").toBe(true);
			const result = await platform.biometric.authenticate("conformance");
			expect(typeof result.success).toBe("boolean");
		});

		test("initialize is idempotent", async () => {
			const { platform } = await make();

			await platform.initialize();
			await platform.initialize();

			await platform.secretSet("init-key", "survives");
			expect(await platform.secretGet("init-key")).toBe("survives");
		});

		// ------------------------------------------------------------------
		// secret*
		// ------------------------------------------------------------------

		test("secret round-trips", async () => {
			const { platform } = await make();

			await platform.secretSet("s:token", "shhh");

			expect(await platform.secretGet("s:token")).toBe("shhh");
		});

		test("secret overwrites silently", async () => {
			const { platform } = await make();

			await platform.secretSet("s:token", "first");
			await platform.secretSet("s:token", "second");

			expect(await platform.secretGet("s:token")).toBe("second");
		});

		test("secretGet returns null for a missing key", async () => {
			const { platform } = await make();

			expect(await platform.secretGet("s:never-written")).toBeNull();
		});

		test("secretDelete removes the value", async () => {
			const { platform } = await make();

			await platform.secretSet("s:token", "shhh");
			await platform.secretDelete("s:token");

			expect(await platform.secretGet("s:token")).toBeNull();
		});

		test("secretDelete of an absent key is a no-op, not a throw", async () => {
			const { platform } = await make();

			await platform.secretDelete("s:never-written");
			await platform.secretDelete("s:never-written");

			expect(await platform.secretGet("s:never-written")).toBeNull();
		});

		test("secret round-trips a value well over 4 KB intact", async () => {
			const { platform } = await make();

			await platform.secretSet("s:big", LARGE_SECRET);

			const read = await platform.secretGet("s:big");
			expect(read).toBe(LARGE_SECRET);
			expect(read?.length).toBe(LARGE_SECRET.length);
		});

		test("an oversized secret can be overwritten by a small one", async () => {
			const { platform } = await make();

			await platform.secretSet("s:big", LARGE_SECRET);
			await platform.secretSet("s:big", "tiny");

			expect(await platform.secretGet("s:big")).toBe("tiny");
		});

		test("an oversized secret is fully removed by secretDelete", async () => {
			const { platform } = await make();

			await platform.secretSet("s:big", LARGE_SECRET);
			await platform.secretDelete("s:big");

			expect(await platform.secretGet("s:big")).toBeNull();
		});

		test("secret round-trips multi-byte content", async () => {
			const { platform } = await make();

			await platform.secretSet("s:unicode", UNICODE_VALUE);

			expect(await platform.secretGet("s:unicode")).toBe(UNICODE_VALUE);
		});

		test("secret round-trips the empty string as a value, not as absent", async () => {
			const { platform } = await make();

			await platform.secretSet("s:empty", "");

			expect(await platform.secretGet("s:empty")).toBe("");
		});

		// ------------------------------------------------------------------
		// kv*, both scopes
		// ------------------------------------------------------------------

		for (const scope of ["device", "session"] as const) {
			test(`kv round-trips at ${scope} scope`, async () => {
				const { platform } = await make();

				await platform.kvSet("k:setting", "on", scope);

				expect(await platform.kvGet("k:setting", scope)).toBe("on");
			});

			test(`kv overwrites silently at ${scope} scope`, async () => {
				const { platform } = await make();

				await platform.kvSet("k:setting", "first", scope);
				await platform.kvSet("k:setting", "second", scope);

				expect(await platform.kvGet("k:setting", scope)).toBe("second");
			});

			test(`kvGet returns null for a missing key at ${scope} scope`, async () => {
				const { platform } = await make();

				expect(await platform.kvGet("k:never-written", scope)).toBeNull();
			});

			test(`kvDelete removes the value at ${scope} scope`, async () => {
				const { platform } = await make();

				await platform.kvSet("k:setting", "on", scope);
				await platform.kvDelete("k:setting", scope);

				expect(await platform.kvGet("k:setting", scope)).toBeNull();
			});

			test(`kvDelete of an absent key is a no-op at ${scope} scope`, async () => {
				const { platform } = await make();

				await platform.kvDelete("k:never-written", scope);
				await platform.kvDelete("k:never-written", scope);

				expect(await platform.kvGet("k:never-written", scope)).toBeNull();
			});

			test(`kv round-trips a large value at ${scope} scope`, async () => {
				const { platform } = await make();

				await platform.kvSet("k:big", LARGE_SECRET, scope);

				expect(await platform.kvGet("k:big", scope)).toBe(LARGE_SECRET);
			});
		}

		// ------------------------------------------------------------------
		// Scope isolation — the property `deriveScope` depends on
		// ------------------------------------------------------------------

		test("a session write is invisible to a device read of the same key", async () => {
			const { platform } = await make();

			await platform.kvSet("k:scoped", "session-value", "session");

			expect(await platform.kvGet("k:scoped", "device")).toBeNull();
		});

		test("a device write is invisible to a session read of the same key", async () => {
			const { platform } = await make();

			await platform.kvSet("k:scoped", "device-value", "device");

			expect(await platform.kvGet("k:scoped", "session")).toBeNull();
		});

		test("the same key holds independent values in each scope", async () => {
			const { platform } = await make();

			await platform.kvSet("k:scoped", "device-value", "device");
			await platform.kvSet("k:scoped", "session-value", "session");

			expect(await platform.kvGet("k:scoped", "device")).toBe("device-value");
			expect(await platform.kvGet("k:scoped", "session")).toBe("session-value");
		});

		test("deleting in one scope leaves the other scope untouched", async () => {
			const { platform } = await make();

			await platform.kvSet("k:scoped", "device-value", "device");
			await platform.kvSet("k:scoped", "session-value", "session");
			await platform.kvDelete("k:scoped", "session");

			expect(await platform.kvGet("k:scoped", "device")).toBe("device-value");
			expect(await platform.kvGet("k:scoped", "session")).toBeNull();
		});

		// ------------------------------------------------------------------
		// kvListKeys
		// ------------------------------------------------------------------

		test("kvListKeys filters by prefix", async () => {
			const { platform } = await make();

			await platform.kvSet("pfx:a", "1", "device");
			await platform.kvSet("pfx:b", "2", "device");
			await platform.kvSet("other:c", "3", "device");

			expect((await platform.kvListKeys("pfx:")).sort()).toEqual([
				"pfx:a",
				"pfx:b",
			]);
		});

		test("kvListKeys spans both scopes", async () => {
			const { platform } = await make();

			await platform.kvSet("pfx:device", "1", "device");
			await platform.kvSet("pfx:session", "2", "session");
			await platform.kvSet("other:d", "3", "device");
			await platform.kvSet("other:s", "4", "session");

			expect((await platform.kvListKeys("pfx:")).sort()).toEqual([
				"pfx:device",
				"pfx:session",
			]);
		});

		test("kvListKeys reports a key present in both scopes exactly once", async () => {
			const { platform } = await make();

			await platform.kvSet("pfx:both", "device-value", "device");
			await platform.kvSet("pfx:both", "session-value", "session");

			expect(await platform.kvListKeys("pfx:")).toEqual(["pfx:both"]);
		});

		test("kvListKeys returns an empty array when nothing matches", async () => {
			const { platform } = await make();

			await platform.kvSet("other:a", "1", "device");

			expect(await platform.kvListKeys("pfx:")).toEqual([]);
		});

		test("kvListKeys stops reporting a deleted key", async () => {
			const { platform } = await make();

			await platform.kvSet("pfx:a", "1", "device");
			await platform.kvSet("pfx:b", "2", "session");
			await platform.kvDelete("pfx:a", "device");

			expect(await platform.kvListKeys("pfx:")).toEqual(["pfx:b"]);
		});

		test("an empty prefix lists everything written through kvSet", async () => {
			const { platform } = await make();

			await platform.kvSet("alpha", "1", "device");
			await platform.kvSet("beta", "2", "session");

			const keys = await platform.kvListKeys("");
			expect(keys).toContain("alpha");
			expect(keys).toContain("beta");
		});
	});

	describe(`${name} adapter — RecordPort`, () => {
		test("initialize is idempotent", async () => {
			const { record } = await make();

			await record.initialize();
			await record.initialize();

			await record.recordPut("c1", "r1", "v1");
			expect(await record.recordGet("c1", "r1")).toBe("v1");
		});

		test("recordPut/recordGet round-trip", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");

			expect(await record.recordGet("c1", "r1")).toBe("v1");
		});

		test("recordPut overwrites the same id", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "first");
			await record.recordPut("c1", "r1", "second");

			expect(await record.recordGet("c1", "r1")).toBe("second");
			expect(await record.recordList("c1")).toEqual([
				{ id: "r1", value: "second" },
			]);
		});

		test("recordGet returns null for a missing id", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");

			expect(await record.recordGet("c1", "missing")).toBeNull();
		});

		test("recordGet returns null for a missing collection", async () => {
			const { record } = await make();

			expect(await record.recordGet("never-used", "r1")).toBeNull();
		});

		test("recordDelete removes exactly one record", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");
			await record.recordPut("c1", "r2", "v2");
			await record.recordDelete("c1", "r1");

			expect(await record.recordGet("c1", "r1")).toBeNull();
			expect(await record.recordGet("c1", "r2")).toBe("v2");
		});

		test("recordDelete of an absent record is a no-op, not a throw", async () => {
			const { record } = await make();

			await record.recordDelete("c1", "missing");
			await record.recordDelete("never-used", "missing");

			expect(await record.recordGet("c1", "missing")).toBeNull();
		});

		test("recordList on an unknown collection returns an empty array", async () => {
			const { record } = await make();

			expect(await record.recordList("never-used")).toEqual([]);
		});

		test("recordList returns every record in the collection", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");
			await record.recordPut("c1", "r2", "v2");
			await record.recordPut("c1", "r3", "v3");

			const listed = (await record.recordList("c1")).sort((a, b) =>
				a.id.localeCompare(b.id),
			);
			expect(listed).toEqual([
				{ id: "r1", value: "v1" },
				{ id: "r2", value: "v2" },
				{ id: "r3", value: "v3" },
			]);
		});

		test("collections are isolated from one another", async () => {
			const { record } = await make();

			await record.recordPut("c1", "shared-id", "from-c1");
			await record.recordPut("c2", "shared-id", "from-c2");

			expect(await record.recordGet("c1", "shared-id")).toBe("from-c1");
			expect(await record.recordGet("c2", "shared-id")).toBe("from-c2");
			expect(await record.recordList("c1")).toEqual([
				{ id: "shared-id", value: "from-c1" },
			]);
			expect(await record.recordList("c2")).toEqual([
				{ id: "shared-id", value: "from-c2" },
			]);
		});

		test("deleting from one collection leaves the other intact", async () => {
			const { record } = await make();

			await record.recordPut("c1", "shared-id", "from-c1");
			await record.recordPut("c2", "shared-id", "from-c2");
			await record.recordDelete("c1", "shared-id");

			expect(await record.recordGet("c1", "shared-id")).toBeNull();
			expect(await record.recordGet("c2", "shared-id")).toBe("from-c2");
		});

		test("recordClear empties only the named collection", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");
			await record.recordPut("c1", "r2", "v2");
			await record.recordPut("c2", "r1", "other");
			await record.recordClear("c1");

			expect(await record.recordList("c1")).toEqual([]);
			expect(await record.recordGet("c1", "r1")).toBeNull();
			expect(await record.recordList("c2")).toEqual([
				{ id: "r1", value: "other" },
			]);
		});

		test("recordClear on an unknown collection is a no-op, not a throw", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");
			await record.recordClear("never-used");

			expect(await record.recordList("c1")).toEqual([
				{ id: "r1", value: "v1" },
			]);
		});

		test("a cleared collection is usable again", async () => {
			const { record } = await make();

			await record.recordPut("c1", "r1", "v1");
			await record.recordClear("c1");
			await record.recordPut("c1", "r2", "v2");

			expect(await record.recordList("c1")).toEqual([
				{ id: "r2", value: "v2" },
			]);
		});

		test("record values survive large payloads and multi-byte content", async () => {
			const { record } = await make();

			await record.recordPut("c1", "big", LARGE_RECORD);
			await record.recordPut("c1", "unicode", UNICODE_VALUE);

			expect(await record.recordGet("c1", "big")).toBe(LARGE_RECORD);
			expect(await record.recordGet("c1", "unicode")).toBe(UNICODE_VALUE);
		});

		test("collection and id strings are opaque to the port", async () => {
			const { record } = await make();

			// `ItemCache` builds collections as `${accountId}:items`; ids are server UUIDs.
			// Ports must never parse either, so awkward separators must round-trip.
			const collection = "acct-1:items";
			const id = "id with spaces:and:colons";

			await record.recordPut(collection, id, "v");

			expect(await record.recordGet(collection, id)).toBe("v");
			expect(await record.recordList(collection)).toEqual([{ id, value: "v" }]);
		});

		test("similarly-named collections do not bleed into one another", async () => {
			const { record } = await make();

			await record.recordPut("acct:items", "r1", "items");
			await record.recordPut("acct:items-extra", "r1", "extra");

			expect(await record.recordList("acct:items")).toEqual([
				{ id: "r1", value: "items" },
			]);
			expect(await record.recordList("acct:items-extra")).toEqual([
				{ id: "r1", value: "extra" },
			]);
		});
	});
}
