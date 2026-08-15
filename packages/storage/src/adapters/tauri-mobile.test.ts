/**
 * Tauri mobile adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a fresh
 * pair of ports backed by faked Tauri modules. The extra tests below pin the facts that are
 * *specific* to mobile and therefore invisible to a suite that must stay platform-agnostic:
 * that the two tiers live in two separate store files and neither leaks into the other, that
 * `secret*` never reaches the biometry plugin, the `${collection}:${id}` key layout and its
 * O(1) upsert, the prefix predicate's immunity to `LIKE` wildcards, and the biometric error
 * mapping.
 *
 * **Which database a test runs on matters, so each one says.** `makeMobilePorts` — and with it
 * the shared conformance suite and every behavioural test below — backs records with a *real*
 * in-memory SQLite database, because only SQLite can say whether this adapter's SQL is right.
 * `makeCountingPorts` backs them with `SqlDatabaseDouble`, which records statements instead of
 * executing them; the four tests that use it are the O(1) round-trip proofs, and they are the
 * only claims that double can support.
 *
 * Two tests here are *compile-time* checks rather than runtime ones: `TauriSqlDatabase` and
 * `TauriMobileBiometry` are structural restatements of two optional plugins' types, and nothing
 * at runtime can tell us whether the restatements still match. The assignments below can.
 */

import { describe, expect, test } from "bun:test";
import type * as BiometryPlugin from "@choochmeque/tauri-plugin-biometry-api";
import type Database from "@tauri-apps/plugin-sql";
import { runPortConformance } from "./port-conformance";
import {
	createTauriMobilePlatformPort,
	createTauriMobileRecordPort,
	type TauriMobileBiometry,
	type TauriSqlDatabase,
} from "./tauri-mobile";
import {
	createTauriMobileCountingDoubles,
	createTauriMobileDoubles,
	type TauriMobileDoubles,
} from "./tauri-mobile-test-doubles";

/**
 * `true` only while the real plugin's `Database` still satisfies the slice this adapter
 * declares; `never` — and therefore a `check-types` failure at the one use below — otherwise.
 *
 * `import type` is erased, so this costs the bundle nothing and the test process never loads
 * the plugin.
 */
type SqlDatabaseStillMatches = Database extends TauriSqlDatabase ? true : never;

/** The same guard for the biometry plugin, whose module *is* the object the adapter calls. */
type BiometryStillMatches = typeof BiometryPlugin extends TauriMobileBiometry
	? true
	: never;

/**
 * Fresh, empty mobile Tauri doubles plus a fresh pair of ports, as the suite requires.
 *
 * Records run on real SQLite here. Everything that asks "what does this adapter *do*" uses
 * this.
 */
async function makeMobilePorts() {
	// `keystoreUnavailable`: these tests are about the `secrets.json` **fallback**, which is
	// what runs on iOS and on any build without the Keystore plugin. The Keystore path has its
	// own conformance run and its own describe block below.
	const doubles = createTauriMobileDoubles({ keystoreUnavailable: true });
	const platform = createTauriMobilePlatformPort(doubles.deps);
	const record = createTauriMobileRecordPort(doubles.deps);
	await platform.initialize();
	await record.initialize();

	return { platform, record, doubles };
}

/**
 * The same, with records on the statement-recording double.
 *
 * Only for counting round trips. It cannot tell right SQL from wrong, so no behavioural claim
 * may rest on it.
 */
async function makeCountingPorts() {
	const doubles = createTauriMobileCountingDoubles();
	const platform = createTauriMobilePlatformPort(doubles.deps);
	const record = createTauriMobileRecordPort(doubles.deps);
	await platform.initialize();
	await record.initialize();

	return { platform, record, doubles };
}

/**
 * The same pair of ports with the Keystore plugin answering — the Android production path.
 *
 * Records still run on real SQLite; only the secret tier moves.
 */
async function makeKeystorePorts() {
	const doubles = createTauriMobileDoubles();
	const platform = createTauriMobilePlatformPort(doubles.deps);
	const record = createTauriMobileRecordPort(doubles.deps);
	await platform.initialize();
	await record.initialize();

	return { platform, record, doubles };
}

// The contract has to hold on **both** secret backings, because both ship: Android gets the
// Keystore, everything else gets `secrets.json`. Running the suite once would prove it of
// whichever one happened to be wired here.
runPortConformance("tauri-mobile (secrets.json fallback)", makeMobilePorts);
runPortConformance("tauri-mobile (Android Keystore)", makeKeystorePorts);

/** A platform port over doubles whose biometry plugin is configured up front. */
async function makeBiometricPort(
	configure: (doubles: TauriMobileDoubles) => void,
) {
	const doubles = createTauriMobileDoubles();
	configure(doubles);
	const platform = createTauriMobilePlatformPort(doubles.deps);
	await platform.initialize();
	return { platform, doubles };
}

describe("tauri-mobile adapter — platform-specific mapping", () => {
	test("declares itself as mobile with a session that survives a restart", async () => {
		const { platform } = await makeMobilePorts();

		expect(platform.platform).toBe("mobile");
		// Killing and relaunching a mobile app does not end the user's session, so every
		// session-bound secret derives scope "device" and lands in the secret store.
		expect(platform.sessionSurvivesRestart).toBe(true);
		expect(platform.tiers).toEqual(["secret", "plain"]);
	});

	/**
	 * `secretBacking` is the security-review answer, so it is tested like one: it must name the
	 * file and it must not leave anyone with the impression that a keychain is involved.
	 * `docs/mobile-migration-decisions.md` D4a.
	 */
	test("states the secret tier's downgrade instead of implying a keychain", async () => {
		const { platform } = await makeMobilePorts();

		expect(platform.secretBacking).toContain("@tauri-apps/plugin-store");
		expect(platform.secretBacking).toContain("secrets.json");
		expect(platform.secretBacking).toContain(
			"NO at-rest separation from the plain tier",
		);
		// Case-insensitive: "keystore" would mislead a reader exactly as much as "Keystore".
		expect(platform.secretBacking).not.toMatch(/keystore/iu);
		expect(platform.secretBacking).not.toMatch(/keychain/iu);
	});

	test("the declared TauriSqlDatabase slice still matches the real plugin type", () => {
		// Compiles only while `Database extends TauriSqlDatabase`; see the type above.
		const stillMatches: SqlDatabaseStillMatches = true;

		expect(stillMatches).toBe(true);
	});

	test("the declared TauriMobileBiometry slice still matches the real plugin type", () => {
		// Compiles only while the plugin module still satisfies the slice. `loadBiometry`
		// returns that module uncast, so this is the whole drift guard for it.
		const stillMatches: BiometryStillMatches = true;

		expect(stillMatches).toBe(true);
	});

	test("publishes an empty record key prefix — no native host reads these records", async () => {
		const { platform, record } = await makeMobilePorts();

		expect(platform.recordKeyPrefix).toBe("");
		expect(record.recordKeyPrefix).toBe("");
	});

	// ------------------------------------------------------------------
	// secret* — secrets.json, and never store.json
	// ------------------------------------------------------------------

	/**
	 * Two files is the only structural guarantee the secret tier still has, so it is tested in
	 * both directions. `docs/mobile-migration-decisions.md` D4a.
	 */
	test("secrets go to secrets.json and never to the kv store", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.secretSet("bittery_device_key", "dk");

		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
		expect(doubles.secrets.contents.get("secret:bittery_device_key")).toBe(
			"dk",
		);
		// `store.json` is the plain tier. A secret must not appear in it under any key.
		expect(doubles.store.sets).toEqual([]);
		expect([...doubles.store.contents.keys()]).toEqual([]);
		expect(await platform.kvGet("bittery_device_key", "device")).toBeNull();
	});

	test("kv values go to store.json and never to the secrets store", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);
		await platform.kvSet("bittery_jwt_token", "session-token", "session");

		expect(doubles.secrets.sets).toEqual([]);
		expect([...doubles.secrets.contents.keys()]).toEqual([]);
		expect(await platform.secretGet("bittery_server_url")).toBeNull();
	});

	test("secrets go to secrets.json, not the record database", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.secretSet("bittery_vault_keys", "vk");

		expect(doubles.database.keys()).toEqual([]);
	});

	/**
	 * The whole reason the secret tier is not keychain-backed here: the biometry plugin's
	 * `getData` prompts on every read, and `AccountStore` reads `jwt_token` on every API
	 * request. No secret-tier call may reach that plugin.
	 */
	test("no secret operation ever raises a biometric prompt", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.secretSet("bittery_jwt_token", "token");
		for (let read = 0; read < 20; read += 1) {
			expect(await platform.secretGet("bittery_jwt_token")).toBe("token");
		}
		await platform.secretDelete("bittery_jwt_token");

		expect(doubles.biometry.prompts).toEqual([]);
	});

	test("secrets are namespaced, so a kv key of the same name cannot alias one", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.secretSet("bittery_device_key", "secret-value");
		await platform.kvSet("bittery_device_key", "plain-value", "device");

		expect([...doubles.secrets.contents.keys()]).toEqual([
			"secret:bittery_device_key",
		]);
		expect([...doubles.store.contents.keys()]).toEqual(["bittery_device_key"]);
	});

	test("every mutating secret call flushes before it resolves", async () => {
		const { platform, doubles } = await makeMobilePorts();
		doubles.secrets.resetCallLog();

		await platform.secretSet("bittery_device_key", "dk");
		expect(doubles.secrets.saves).toBe(1);

		await platform.secretDelete("bittery_device_key");
		expect(doubles.secrets.saves).toBe(2);

		await platform.secretGet("bittery_device_key");
		expect(doubles.secrets.saves).toBe(2);
	});

	test("secretDelete of an absent key is a no-op, not a throw", async () => {
		const { platform } = await makeMobilePorts();

		await platform.secretDelete("bittery_never_written");
		await platform.secretDelete("bittery_never_written");

		expect(await platform.secretGet("bittery_never_written")).toBeNull();
	});

	/**
	 * A store that cannot accept key material is fatal, by design: there is no second copy to
	 * fall back on, so a swallowed write would lose the value silently.
	 */
	test("a failing secretSet propagates rather than silently dropping key material", async () => {
		const { platform, doubles } = await makeMobilePorts();
		doubles.secrets.setFailure = new Error("Failed to write secrets.json");

		await expect(
			platform.secretSet("bittery_device_key", "dk"),
		).rejects.toThrow("Failed to write secrets.json");
	});

	/**
	 * The read half of "never throws": a secrets store that cannot be opened at all — an
	 * uninstalled `@tauri-apps/plugin-store`, a corrupt file, a device with no space to open
	 * one — is indistinguishable from an empty one above this port.
	 */
	test("secretGet answers null when the secrets store cannot be opened", async () => {
		const doubles = createTauriMobileDoubles({ storeModuleMissing: true });
		const platform = createTauriMobilePlatformPort(doubles.deps);

		expect(await platform.secretGet("bittery_jwt_token")).toBeNull();
	});

	/**
	 * The delete half, and the one that matters most. `AccountStore.clearSession` deletes
	 * `jwt_token`, then `vault_keys`, then `encrypted_private_key`, then drops the cached
	 * master unlock key — with no try/catch anywhere in that chain. A throw from the first
	 * delete leaves key material on disk and the account still unlocked, so this primitive
	 * must swallow, exactly as `tauri.ts` and `react-native.ts` do.
	 */
	test("secretDelete is a no-op when the secrets store cannot be opened", async () => {
		const doubles = createTauriMobileDoubles({ storeModuleMissing: true });
		const platform = createTauriMobilePlatformPort(doubles.deps);

		await platform.secretDelete("bittery_jwt_token");
		await platform.secretDelete("bittery_vault_keys");
	});

	/** The same, one layer in: the file opens, but the fsync behind `delete` fails. */
	test("secretDelete is a no-op when the flush behind it fails", async () => {
		const { platform, doubles } = await makeMobilePorts();
		// ENOSPC, or any other reason `store.save()` can reject.
		doubles.secrets.saveFailure = new Error("No space left on device");

		await platform.secretDelete("bittery_jwt_token");
	});

	test("an 8 KB secret is stored whole — this backing store needs no chunking", async () => {
		const { platform, doubles } = await makeMobilePorts();
		const large = "0123456789abcdef".repeat(512);

		await platform.secretSet("bittery_vault_keys", large);

		expect(await platform.secretGet("bittery_vault_keys")).toBe(large);
		// One entry, not a manifest plus N chunks: a JSON store value has no size cap the way
		// `expo-secure-store` does.
		expect(doubles.secrets.contents.size).toBe(1);
	});

	// ------------------------------------------------------------------
	// kv* — store.json, two namespaces
	// ------------------------------------------------------------------

	test("device-scope keys are written bare", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);

		expect(doubles.store.contents.get("bittery_server_url")).toBe(
			"https://example.test",
		);
	});

	test("session-scope keys are namespaced away from device-scope keys", async () => {
		const { platform, doubles } = await makeMobilePorts();

		await platform.kvSet("bittery_jwt_token", "session-token", "session");
		await platform.kvSet("bittery_jwt_token", "device-token", "device");

		expect(doubles.store.contents.get("session:bittery_jwt_token")).toBe(
			"session-token",
		);
		expect(doubles.store.contents.get("bittery_jwt_token")).toBe(
			"device-token",
		);
		expect(await platform.kvGet("bittery_jwt_token", "session")).toBe(
			"session-token",
		);
		expect(await platform.kvGet("bittery_jwt_token", "device")).toBe(
			"device-token",
		);
	});

	test("kvListKeys strips the session prefix and reports each key once", async () => {
		const { platform } = await makeMobilePorts();

		await platform.kvSet("bittery_jwt_token", "s", "session");
		await platform.kvSet("bittery_jwt_token", "d", "device");
		await platform.kvSet("bittery_server_url", "u", "device");

		expect(await platform.kvListKeys("bittery_")).toEqual([
			"bittery_jwt_token",
			"bittery_server_url",
		]);
	});

	test("every mutating kv call flushes before it resolves", async () => {
		const { platform, doubles } = await makeMobilePorts();
		doubles.store.resetCallLog();

		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);
		expect(doubles.store.saves).toBe(1);

		await platform.kvDelete("bittery_server_url", "device");
		expect(doubles.store.saves).toBe(2);

		await platform.kvGet("bittery_server_url", "device");
		await platform.kvListKeys("bittery_");
		expect(doubles.store.saves).toBe(2);
	});

	// ------------------------------------------------------------------
	// RecordPort — real SQLite
	// ------------------------------------------------------------------

	test("initialize creates the table without depending on a Rust-side migration", async () => {
		const doubles = createTauriMobileDoubles();
		const record = createTauriMobileRecordPort(doubles.deps);

		// Nothing to write into before `initialize`, so a put would raise "no such table".
		expect(doubles.database.keys()).toEqual([]);
		await record.initialize();

		await record.recordPut("acct-1:items", "item-1", "blob");
		expect(doubles.database.keys()).toEqual(["acct-1:items:item-1"]);
	});

	test("records are stored one row per record under {collection}:{id}", async () => {
		const { record, doubles } = await makeMobilePorts();

		await record.recordPut("acct-1:items", "item-1", "blob");

		expect(doubles.database.value("acct-1:items:item-1")).toBe("blob");
	});

	test("recordPutMany lets a later record win over an earlier one with the same id", async () => {
		const { record } = await makeMobilePorts();

		await record.recordPutMany("acct-1:items", [
			{ id: "item-1", value: "first" },
			{ id: "item-2", value: "other" },
			{ id: "item-1", value: "second" },
		]);

		expect(await record.recordGet("acct-1:items", "item-1")).toBe("second");
		expect(await record.recordGet("acct-1:items", "item-2")).toBe("other");
	});

	/** A 2 000-item vault bootstrap, chunked, against the engine that enforces the cap. */
	test("recordPutMany writes every record of a chunked bootstrap", async () => {
		const { record } = await makeMobilePorts();
		const records = Array.from({ length: 2000 }, (_unused, index) => ({
			id: `item-${index}`,
			value: `blob-${index}`,
		}));

		await record.recordPutMany("acct-1:items", records);

		expect(await record.recordList("acct-1:items")).toHaveLength(2000);
		expect(await record.recordGet("acct-1:items", "item-1999")).toBe(
			"blob-1999",
		);
	});

	// ------------------------------------------------------------------
	// RecordPort — round-trip counting, on the recording double
	//
	// These four are the only tests that use `makeCountingPorts`. They assert *how many*
	// statements the adapter issues, never what SQLite makes of them.
	// ------------------------------------------------------------------

	test("initialize issues the CREATE TABLE itself, before any other statement", async () => {
		const doubles = createTauriMobileCountingDoubles();
		const record = createTauriMobileRecordPort(doubles.deps);

		expect(doubles.database.created).toBe(false);
		await record.initialize();

		expect(doubles.database.created).toBe(true);
		expect(doubles.database.executes[0]?.query).toBe(
			"CREATE TABLE IF NOT EXISTS records ( key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL )",
		);
	});

	/**
	 * The O(1) proof. `vault-repository.ts` upserts one item at a time on delta sync, so a
	 * read-modify-write here would make a delta sync O(n^2).
	 */
	test("recordPut issues one upsert and never reads first", async () => {
		const { record, doubles } = await makeCountingPorts();
		for (let index = 0; index < 100; index += 1) {
			await record.recordPut("acct-1:items", `item-${index}`, "blob");
		}
		doubles.database.resetCallLog();

		await record.recordPut("acct-1:items", "item-50", "updated");

		expect(doubles.database.selects).toEqual([]);
		expect(doubles.database.executes).toEqual([
			{
				query:
					"INSERT INTO records (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				values: ["acct-1:items:item-50", "updated"],
			},
		]);
		expect(await record.recordGet("acct-1:items", "item-50")).toBe("updated");
		expect(await record.recordList("acct-1:items")).toHaveLength(100);
	});

	test("recordDelete issues one statement and never reads first", async () => {
		const { record, doubles } = await makeCountingPorts();
		await record.recordPut("acct-1:items", "item-1", "blob");
		await record.recordPut("acct-1:items", "item-2", "blob");
		doubles.database.resetCallLog();

		await record.recordDelete("acct-1:items", "item-1");

		expect(doubles.database.selects).toEqual([]);
		expect(doubles.database.executes).toEqual([
			{
				query: "DELETE FROM records WHERE key = ?1",
				values: ["acct-1:items:item-1"],
			},
		]);
	});

	/**
	 * One multi-row statement is one implicit transaction, so N rows cost one commit. Explicit
	 * BEGIN/COMMIT would be unsafe: `tauri-plugin-sql` runs each call through a connection
	 * pool, so the statements could land on different connections.
	 */
	test("recordPutMany writes 250 records in a single statement", async () => {
		const { record, doubles } = await makeCountingPorts();
		const records = Array.from({ length: 250 }, (_unused, index) => ({
			id: `item-${index}`,
			value: `blob-${index}`,
		}));
		doubles.database.resetCallLog();

		await record.recordPutMany("acct-1:items", records);

		expect(doubles.database.executes).toHaveLength(1);
		expect(doubles.database.executes[0]?.values).toHaveLength(500);
		expect(await record.recordList("acct-1:items")).toHaveLength(250);
	});

	test("recordPutMany chunks under SQLite's bound-variable cap", async () => {
		const { record, doubles } = await makeCountingPorts();
		// A 2 000-item vault bootstrap comes through here. Two variables per row, so no
		// statement may carry more than 999 of them on an older SQLite build.
		const records = Array.from({ length: 2000 }, (_unused, index) => ({
			id: `item-${index}`,
			value: `blob-${index}`,
		}));
		doubles.database.resetCallLog();

		await record.recordPutMany("acct-1:items", records);

		expect(doubles.database.executes).toHaveLength(7);
		for (const call of doubles.database.executes) {
			expect(call.values.length).toBeLessThan(999);
		}
		expect(await record.recordList("acct-1:items")).toHaveLength(2000);
	});

	// ------------------------------------------------------------------
	// The prefix predicate — why it is not LIKE
	//
	// Back on real SQLite: the whole point of these is what SQLite makes of the statement.
	// ------------------------------------------------------------------

	test("a collection name containing % does not match another collection's rows", async () => {
		const { record } = await makeMobilePorts();

		await record.recordPut("acct%:items", "wild", "from-wildcard");
		await record.recordPut("acct-1:items", "real", "from-real");

		expect(await record.recordList("acct%:items")).toEqual([
			{ id: "wild", value: "from-wildcard" },
		]);

		await record.recordClear("acct%:items");

		expect(await record.recordGet("acct-1:items", "real")).toBe("from-real");
	});

	test("a collection name containing _ does not match another collection's rows", async () => {
		const { record } = await makeMobilePorts();

		await record.recordPut("acct_1:items", "wild", "from-wildcard");
		await record.recordPut("acct-1:items", "real", "from-real");

		expect(await record.recordList("acct_1:items")).toEqual([
			{ id: "wild", value: "from-wildcard" },
		]);

		await record.recordClear("acct_1:items");

		expect(await record.recordGet("acct-1:items", "real")).toBe("from-real");
	});

	test("the prefix predicate is case-sensitive, unlike LIKE", async () => {
		const { record } = await makeMobilePorts();

		await record.recordPut("ACCT:items", "r1", "upper");
		await record.recordPut("acct:items", "r1", "lower");

		expect(await record.recordList("acct:items")).toEqual([
			{ id: "r1", value: "lower" },
		]);

		await record.recordClear("acct:items");

		expect(await record.recordGet("ACCT:items", "r1")).toBe("upper");
	});

	test("a collection name containing a backslash is matched literally", async () => {
		const { record } = await makeMobilePorts();

		await record.recordPut("acct\\%:items", "r1", "escaped");
		await record.recordPut("acct-1:items", "r1", "real");

		expect(await record.recordList("acct\\%:items")).toEqual([
			{ id: "r1", value: "escaped" },
		]);
	});

	/**
	 * `length(?1)` rather than a JavaScript-computed length, and `row.key.slice(prefix.length)`
	 * in JavaScript rather than a SQL `substr` — the two count differently above the BMP, so
	 * the id this port recovers is only right while each measurement is taken on its own side.
	 * Every character here is two UTF-16 code units and one SQLite character.
	 */
	test("an astral-plane collection name lists and clears its own rows only", async () => {
		const { record } = await makeMobilePorts();

		await record.recordPut("🔐𝕍ault:items", "𝓲d-1", "astral");
		await record.recordPut("🔓other:items", "r1", "neighbour");

		expect(await record.recordGet("🔐𝕍ault:items", "𝓲d-1")).toBe("astral");
		expect(await record.recordList("🔐𝕍ault:items")).toEqual([
			{ id: "𝓲d-1", value: "astral" },
		]);

		await record.recordClear("🔐𝕍ault:items");

		expect(await record.recordList("🔐𝕍ault:items")).toEqual([]);
		expect(await record.recordGet("🔓other:items", "r1")).toBe("neighbour");
	});

	/**
	 * `@tauri-apps/plugin-sql` is an optional peer dependency, so "not installed" is a real
	 * build. Unlike the biometric port, `RecordPort` has no honest "no" to answer: a
	 * `recordPut` that resolved without storing anything would lose data, and a `recordGet`
	 * that answered `null` would tell `ItemCache` the cache is simply empty. So every record
	 * primitive carries the loader's failure out.
	 */
	test("an uninstalled sql plugin fails loudly rather than pretending to store records", async () => {
		const doubles = createTauriMobileDoubles({ sqlModuleMissing: true });
		const record = createTauriMobileRecordPort(doubles.deps);
		const absent = "@tauri-apps/plugin-sql";

		await expect(record.initialize()).rejects.toThrow(absent);
		await expect(record.recordPut("c1", "r1", "v")).rejects.toThrow(absent);
		await expect(
			record.recordPutMany("c1", [{ id: "r1", value: "v" }]),
		).rejects.toThrow(absent);
		await expect(record.recordGet("c1", "r1")).rejects.toThrow(absent);
		await expect(record.recordDelete("c1", "r1")).rejects.toThrow(absent);
		await expect(record.recordList("c1")).rejects.toThrow(absent);
		await expect(record.recordClear("c1")).rejects.toThrow(absent);
	});

	/** The two ports are independent: no record database still means a working secret tier. */
	test("an uninstalled sql plugin leaves the platform port working", async () => {
		const doubles = createTauriMobileDoubles({ sqlModuleMissing: true });
		const platform = createTauriMobilePlatformPort(doubles.deps);
		await platform.initialize();

		await platform.secretSet("bittery_device_key", "dk");

		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
	});

	test("the store and the database survive a fresh pair of ports", async () => {
		const doubles = createTauriMobileDoubles();
		const platform = createTauriMobilePlatformPort(doubles.deps);
		const record = createTauriMobileRecordPort(doubles.deps);
		await platform.initialize();
		await record.initialize();
		await platform.secretSet("bittery_device_key", "dk");
		await platform.kvSet("bittery_active_account", "a", "device");
		await record.recordPut("acct-1:items", "item-1", "blob");

		const restarted = createTauriMobilePlatformPort(doubles.deps);
		const restartedRecords = createTauriMobileRecordPort(doubles.deps);
		await restarted.initialize();
		await restartedRecords.initialize();

		expect(await restarted.secretGet("bittery_device_key")).toBe("dk");
		expect(await restarted.kvGet("bittery_active_account", "device")).toBe("a");
		expect(await restartedRecords.recordGet("acct-1:items", "item-1")).toBe(
			"blob",
		);
	});
});

describe("tauri-mobile adapter — biometric", () => {
	test("reports availability and type from checkStatus", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.status = { isAvailable: true, biometryType: 3 };
		});

		expect(await platform.biometric.isAvailable()).toBe(true);
		expect(await platform.biometric.getType()).toBe("face");
		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: true,
			isEnrolled: true,
		});

		const touchId = await makeBiometricPort((doubles) => {
			doubles.biometry.status = { isAvailable: true, biometryType: 2 };
		});
		expect(await touchId.platform.biometric.getType()).toBe("fingerprint");
	});

	test("distinguishes hardware present but nothing enrolled", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.status = {
				isAvailable: false,
				biometryType: 0,
				errorCode: "biometryNotEnrolled",
			};
		});

		expect(await platform.biometric.isAvailable()).toBe(false);
		expect(await platform.biometric.getType()).toBeNull();
		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: true,
			isEnrolled: false,
		});
	});

	test("a successful prompt reports success and passes the reason through", async () => {
		const { platform, doubles } = await makeBiometricPort(() => {});

		expect(await platform.biometric.authenticate("Unlock your vault")).toEqual({
			success: true,
		});
		expect(doubles.biometry.prompts).toEqual(["Unlock your vault"]);
	});

	test("a cancelled prompt is user_cancelled, not a generic failure", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.authFailure = new Error(
				"Authentication was cancelled by the user",
			);
		});

		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "user_cancelled",
			message: "Authentication was cancelled by the user",
		});
	});

	test("a lockout is reported as a lockout", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.authFailure = "biometryLockout";
		});

		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "lockout",
			message: "biometryLockout",
		});
	});

	test("absent enrolment is reported as not_enrolled", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.authFailure = new Error("biometryNotEnrolled");
		});

		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "not_enrolled",
			message: "biometryNotEnrolled",
		});
	});

	test("anything else is a plain failure, carrying the native message", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.authFailure = new Error("Fingerprint not recognised");
		});

		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "failed",
			message: "Fingerprint not recognised",
		});
	});

	/**
	 * A build without the plugin must still expose a *total* biometric port. It is loaded
	 * lazily for exactly that reason, so `initialize()` succeeds and every method answers
	 * "no" rather than raising.
	 */
	test("an uninstalled biometry plugin is honestly unavailable, never a throw", async () => {
		const doubles = createTauriMobileDoubles({ biometryModuleMissing: true });
		const platform = createTauriMobilePlatformPort(doubles.deps);
		await platform.initialize();

		expect(await platform.biometric.isAvailable()).toBe(false);
		expect(await platform.biometric.getType()).toBeNull();
		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: false,
			isEnrolled: false,
		});
		expect((await platform.biometric.authenticate("unlock")).error).toBe(
			"not_available",
		);
	});

	/** The other half of D4a: the secret tier no longer depends on that plugin at all. */
	test("an uninstalled biometry plugin leaves the secret tier working", async () => {
		const doubles = createTauriMobileDoubles({ biometryModuleMissing: true });
		const platform = createTauriMobilePlatformPort(doubles.deps);
		await platform.initialize();

		await platform.secretSet("bittery_device_key", "dk");

		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
	});
});

// ============================================================================
// tauri-plugin-bittery-keystore
// ============================================================================

/**
 * The secret tier's Android Keystore backing, and its fallback.
 *
 * Two things are being pinned here and they are different. One is *routing*: after the probe
 * says yes, no secret may reach `secrets.json`, and after it says no, none may reach the plugin.
 * The other is that neither answer may weaken the port contract — a Keystore that throws must
 * still answer `null` for a missing key and still no-op a delete, because `AccountStore`
 * `clearSession` aborts on a throw and leaves the vault unlocked with `vault_keys` on disk.
 *
 * The migration tests sit here rather than with the store tests because the thing at risk is the
 * user's data, not a code path: someone with secrets in `secrets.json` who installs a
 * Keystore-capable build must come out the other side signed in.
 */
describe("tauri-mobile adapter — Android Keystore secret backing", () => {
	/** A platform port with the doubles reachable, configured before `initialize()` runs. */
	async function makeKeystorePlatform(
		options: Parameters<typeof createTauriMobileDoubles>[0] = {},
		configure: (doubles: TauriMobileDoubles) => void = () => {},
	) {
		const doubles = createTauriMobileDoubles(options);
		configure(doubles);
		const platform = createTauriMobilePlatformPort(doubles.deps);
		await platform.initialize();
		return { platform, doubles };
	}

	// ------------------------------------------------------------------
	// The probe, and what it routes
	// ------------------------------------------------------------------

	test("a probe that says yes routes every secret to the Keystore and none to secrets.json", async () => {
		const { platform, doubles } = await makeKeystorePlatform();

		await platform.secretSet("bittery_vault_keys", "vk");

		expect(await platform.secretGet("bittery_vault_keys")).toBe("vk");
		expect(doubles.keystore.contents.get("secret:bittery_vault_keys")).toBe(
			"vk",
		);
		// The whole point of M1-C9: key material stops landing in the plain JSON file.
		expect(doubles.secrets.contents.size).toBe(0);
		expect(doubles.secrets.sets).toEqual([]);
	});

	test("a probe that says no keeps every secret in secrets.json and never calls the plugin", async () => {
		const { platform, doubles } = await makeKeystorePlatform({
			keystoreUnavailable: true,
		});
		doubles.keystore.resetCallLog();

		await platform.secretSet("bittery_vault_keys", "vk");

		expect(await platform.secretGet("bittery_vault_keys")).toBe("vk");
		expect(doubles.secrets.contents.get("secret:bittery_vault_keys")).toBe(
			"vk",
		);
		expect(doubles.keystore.contents.size).toBe(0);
		expect(doubles.keystore.calls).toEqual([]);
	});

	/**
	 * The harshest unavailability: no plugin registered at all, so the *loader* rejects rather
	 * than the probe answering. An APK built before M1-C9, or any iOS build.
	 */
	test("a build with no keystore plugin falls back instead of failing to initialize", async () => {
		const { platform, doubles } = await makeKeystorePlatform({
			keystoreModuleMissing: true,
		});

		await platform.secretSet("bittery_device_key", "dk");

		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
		expect(doubles.secrets.contents.get("secret:bittery_device_key")).toBe(
			"dk",
		);
	});

	/** A plugin that is registered but whose probe *rejects* is the same fact: fall back. */
	test("a probe that rejects falls back rather than propagating", async () => {
		const { platform, doubles } = await makeKeystorePlatform({}, (d) => {
			d.keystore.probeFailure = new Error("plugin bittery-keystore not found");
		});

		await platform.secretSet("bittery_device_key", "dk");

		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
		expect(doubles.secrets.contents.get("secret:bittery_device_key")).toBe(
			"dk",
		);
	});

	/** One probe per port, not one per secret read. `jwt_token` is read on every request. */
	test("the probe runs once, in initialize, not on every secret call", async () => {
		const { platform, doubles } = await makeKeystorePlatform();

		await platform.secretSet("a", "1");
		await platform.secretGet("a");
		await platform.secretGet("a");
		await platform.secretDelete("a");

		expect(
			doubles.keystore.calls.filter(
				(call) => call.cmd === "plugin:bittery-keystore|secret_available",
			),
		).toHaveLength(1);
	});

	// ------------------------------------------------------------------
	// secretBacking — the security-review answer, in all three states
	// ------------------------------------------------------------------

	/**
	 * Before `initialize()` the fallback is the truth: nothing has yet established that a
	 * Keystore exists, so claiming one would be claiming something unobserved.
	 */
	test("secretBacking reports the fallback before initialize has probed", () => {
		const doubles = createTauriMobileDoubles();
		const platform = createTauriMobilePlatformPort(doubles.deps);

		expect(platform.secretBacking).toContain("secrets.json");
		expect(platform.secretBacking).toContain(
			"NO at-rest separation from the plain tier",
		);
		expect(platform.secretBacking).not.toMatch(/keystore/iu);
	});

	/**
	 * After a successful probe it names the plugin and repeats the plugin's own words — which
	 * are built in `KeystorePlugin.kt` from what `KeyInfo` actually reported. Rewriting them
	 * here would be the one way to turn an observation into a claim.
	 */
	test("secretBacking names the plugin and passes its observation through verbatim", async () => {
		const { platform, doubles } = await makeKeystorePlatform();

		expect(platform.secretBacking).toContain("tauri-plugin-bittery-keystore");
		expect(platform.secretBacking).toContain(doubles.keystore.backing);
		expect(platform.secretBacking).not.toContain("secrets.json");
	});

	/**
	 * A software-backed key must read as software-backed, not as "the Keystore, so hardware".
	 *
	 * The double already defaults to this string — the emulator's real answer — but it is set
	 * here anyway so the test states what it pins rather than leaning on a default.
	 */
	test("secretBacking does not upgrade a software-backed key into a hardware claim", async () => {
		const { platform } = await makeKeystorePlatform({}, (d) => {
			d.keystore.backing =
				"Android Keystore AES-256-GCM, alias bittery_secret_v1, no user-auth required — NOT hardware-backed (software, KeyInfo.securityLevel)";
		});

		expect(platform.secretBacking).toContain("NOT hardware-backed");
	});

	test("secretBacking reports the fallback after a probe that declined", async () => {
		const { platform } = await makeKeystorePlatform({
			keystoreUnavailable: true,
		});

		expect(platform.secretBacking).toContain("@tauri-apps/plugin-store");
		expect(platform.secretBacking).toContain("secrets.json");
		expect(platform.secretBacking).not.toMatch(/keystore/iu);
	});

	// ------------------------------------------------------------------
	// The contract survives a plugin that throws
	// ------------------------------------------------------------------

	/**
	 * An invoke *rejection* — a dead bridge, an unregistered command. `KeystorePlugin.secretGet`
	 * itself never rejects; it catches everything and resolves `null`. The two tests below cover
	 * that side.
	 */
	test("a Keystore that throws on get answers null rather than propagating", async () => {
		const { platform, doubles } = await makeKeystorePlatform();
		await platform.secretSet("bittery_jwt_token", "jwt");
		doubles.keystore.getFailure = new Error("keystore read failed");

		expect(await platform.secretGet("bittery_jwt_token")).toBeNull();
	});

	/**
	 * A read that failed *this time* must not cost the value.
	 *
	 * `BackendBusyException` is documented by Android as retryable, and a keystore2 restart
	 * resolves itself; deleting on either turns a 50 ms hiccup into "re-enter your master
	 * password and Secret Key". The real guarantee lives in `KeystorePlugin.isPermanentlyUnreadable`
	 * and **nothing in this process can constrain that Kotlin** — `KeystoreDouble.unreadable` is
	 * a hand-written mirror of it. This test pins the mirror and the adapter's behaviour above
	 * it; the Kotlin is held by review only.
	 */
	test("a transient Keystore read failure answers null and keeps the value for the retry", async () => {
		const { platform, doubles } = await makeKeystorePlatform();
		await platform.secretSet("bittery_vault_keys", "vk");
		doubles.keystore.unreadable.add("secret:bittery_vault_keys");

		expect(await platform.secretGet("bittery_vault_keys")).toBeNull();

		doubles.keystore.unreadable.clear();
		expect(await platform.secretGet("bittery_vault_keys")).toBe("vk");
	});

	/** The one read that may delete: the ciphertext is provably dead, so it is dropped. */
	test("a provably undecryptable value answers null and is dropped", async () => {
		const { platform, doubles } = await makeKeystorePlatform();
		await platform.secretSet("bittery_vault_keys", "vk");
		doubles.keystore.undecryptable.add("secret:bittery_vault_keys");

		expect(await platform.secretGet("bittery_vault_keys")).toBeNull();
		expect(doubles.keystore.contents.has("secret:bittery_vault_keys")).toBe(
			false,
		);
	});

	/**
	 * The review finding this exists to prevent: a throw out of `secretDelete` aborts
	 * `AccountStore.clearSession`, leaving the vault unlocked with `vault_keys` on disk.
	 */
	test("a Keystore that throws on delete is a no-op, never a throw", async () => {
		const { platform, doubles } = await makeKeystorePlatform();
		await platform.secretSet("bittery_vault_keys", "vk");
		doubles.keystore.deleteFailure = new Error("keystore delete failed");

		expect(await platform.secretDelete("bittery_vault_keys")).toBeUndefined();
	});

	test("deleting an absent key through the Keystore is a no-op", async () => {
		const { platform } = await makeKeystorePlatform();

		expect(await platform.secretDelete("never_written")).toBeUndefined();
	});

	test("a missing key answers null through the Keystore", async () => {
		const { platform } = await makeKeystorePlatform();

		expect(await platform.secretGet("never_written")).toBeNull();
	});

	/**
	 * `secretSet` stays unwrapped on both backings. A store that cannot accept key material is
	 * fatal, and there is no second copy to fall back on — silently dropping it would leave the
	 * caller believing a key was persisted when it was not.
	 */
	test("a failing Keystore write propagates rather than silently dropping key material", async () => {
		const { platform, doubles } = await makeKeystorePlatform();
		doubles.keystore.setFailure = new Error("keystore write failed");

		await expect(
			platform.secretSet("bittery_vault_keys", "vk"),
		).rejects.toThrow("keystore write failed");
	});

	test("secretSet overwrites through the Keystore", async () => {
		const { platform } = await makeKeystorePlatform();

		await platform.secretSet("bittery_jwt_token", "first");
		await platform.secretSet("bittery_jwt_token", "second");

		expect(await platform.secretGet("bittery_jwt_token")).toBe("second");
	});

	// ------------------------------------------------------------------
	// secrets.json -> Keystore migration
	// ------------------------------------------------------------------

	/** Everything an existing install already holds, keyed as the adapter stores it. */
	function seedExistingSecrets(doubles: TauriMobileDoubles): void {
		doubles.secrets.contents.set("secret:bittery_vault_keys", "vk");
		doubles.secrets.contents.set("secret:bittery_device_key", "dk");
		doubles.secrets.contents.set("secret:bittery_jwt_token", "jwt");
	}

	test("an existing secrets.json is drained into the Keystore on first Keystore-capable launch", async () => {
		const { platform, doubles } = await makeKeystorePlatform(
			{},
			seedExistingSecrets,
		);

		expect(doubles.keystore.contents.get("secret:bittery_vault_keys")).toBe(
			"vk",
		);
		expect(doubles.keystore.contents.get("secret:bittery_device_key")).toBe(
			"dk",
		);
		expect(doubles.keystore.contents.get("secret:bittery_jwt_token")).toBe(
			"jwt",
		);
		// The originals are gone, which is the whole point: they were the exposure.
		expect(doubles.secrets.contents.size).toBe(0);
		// And the user is still signed in — reads answer from the new backing.
		expect(await platform.secretGet("bittery_vault_keys")).toBe("vk");
	});

	/** A plain-tier value in the same file is not a secret and must be left exactly alone. */
	test("the drain touches only secret:-prefixed keys", async () => {
		const { doubles } = await makeKeystorePlatform({}, (d) => {
			seedExistingSecrets(d);
			d.secrets.contents.set("not_a_secret", "leave me");
		});

		expect(doubles.secrets.contents.get("not_a_secret")).toBe("leave me");
		expect(doubles.keystore.contents.has("not_a_secret")).toBe(false);
	});

	/** Second launch: nothing left to move, and nothing written twice. */
	test("the drain is idempotent — a second launch moves nothing", async () => {
		const doubles = createTauriMobileDoubles();
		seedExistingSecrets(doubles);
		await createTauriMobilePlatformPort(doubles.deps).initialize();
		doubles.keystore.resetCallLog();
		doubles.secrets.resetCallLog();

		const second = createTauriMobilePlatformPort(doubles.deps);
		await second.initialize();

		expect(
			doubles.keystore.calls.filter(
				(call) => call.cmd === "plugin:bittery-keystore|secret_set",
			),
		).toEqual([]);
		expect(doubles.secrets.deletes).toEqual([]);
		expect(await second.secretGet("bittery_vault_keys")).toBe("vk");
	});

	/**
	 * The crash-safety claim, tested where it hurts: the write of the second value fails, so
	 * the drain never reaches its delete phase.
	 *
	 * Nothing may be missing afterwards. The port stays on `secrets.json` — where every value
	 * still is — and the next launch retries the whole drain.
	 */
	test("an interrupted drain loses nothing and leaves the port on secrets.json", async () => {
		const { platform, doubles } = await makeKeystorePlatform({}, (d) => {
			seedExistingSecrets(d);
			d.keystore.setFailAfter = 1;
		});

		expect(doubles.secrets.contents.size).toBe(3);
		expect(doubles.secrets.deletes).toEqual([]);
		expect(platform.secretBacking).toContain("secrets.json");
		expect(await platform.secretGet("bittery_vault_keys")).toBe("vk");
		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
		expect(await platform.secretGet("bittery_jwt_token")).toBe("jwt");
	});

	/** And the retry on the next launch completes, so an interruption is a delay, not a loss. */
	test("the launch after an interrupted drain completes the migration", async () => {
		const doubles = createTauriMobileDoubles();
		seedExistingSecrets(doubles);
		doubles.keystore.setFailAfter = 1;
		await createTauriMobilePlatformPort(doubles.deps).initialize();

		doubles.keystore.setFailAfter = null;
		const second = createTauriMobilePlatformPort(doubles.deps);
		await second.initialize();

		expect(doubles.secrets.contents.size).toBe(0);
		expect(second.secretBacking).toContain("tauri-plugin-bittery-keystore");
		expect(await second.secretGet("bittery_vault_keys")).toBe("vk");
		expect(await second.secretGet("bittery_device_key")).toBe("dk");
		expect(await second.secretGet("bittery_jwt_token")).toBe("jwt");
	});

	/**
	 * A write that reports success but does not land is why the drain reads back at all. One
	 * unverified value is enough to abandon the whole migration and keep every original.
	 */
	test("a drain whose read-back disagrees deletes nothing", async () => {
		const { platform, doubles } = await makeKeystorePlatform({}, (d) => {
			seedExistingSecrets(d);
			d.keystore.corruptReadBack.add("secret:bittery_device_key");
		});

		expect(doubles.secrets.contents.size).toBe(3);
		expect(doubles.secrets.deletes).toEqual([]);
		expect(platform.secretBacking).toContain("secrets.json");
		expect(await platform.secretGet("bittery_device_key")).toBe("dk");
	});

	/** Nothing to move is the common case, and it must not cost a write either. */
	test("a fresh install adopts the Keystore with no drain at all", async () => {
		const { platform, doubles } = await makeKeystorePlatform();

		expect(
			doubles.keystore.calls.filter(
				(call) => call.cmd === "plugin:bittery-keystore|secret_set",
			),
		).toEqual([]);
		expect(platform.secretBacking).toContain("tauri-plugin-bittery-keystore");
	});
});
