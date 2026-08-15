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
 * One test here is a *compile-time* check rather than a runtime one: `TauriSqlDatabase` is a
 * structural restatement of `@tauri-apps/plugin-sql`'s `Database`, and nothing at runtime can
 * tell us whether the restatement still matches. The assignment below can.
 */

import { describe, expect, test } from "bun:test";
import type Database from "@tauri-apps/plugin-sql";
import { runPortConformance } from "./port-conformance";
import {
	createTauriMobilePlatformPort,
	createTauriMobileRecordPort,
	type TauriSqlDatabase,
} from "./tauri-mobile";
import {
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

/** Fresh, empty mobile Tauri doubles plus a fresh pair of ports, as the suite requires. */
async function makeMobilePorts() {
	const doubles = createTauriMobileDoubles();
	const platform = createTauriMobilePlatformPort(doubles.deps);
	const record = createTauriMobileRecordPort(doubles.deps);
	await platform.initialize();
	await record.initialize();

	return { platform, record, doubles };
}

runPortConformance("tauri-mobile", makeMobilePorts);

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
		expect(platform.secretBacking).not.toContain("Keystore");
		expect(platform.secretBacking).not.toContain("Keychain");
	});

	test("the declared TauriSqlDatabase slice still matches the real plugin type", () => {
		// Compiles only while `Database extends TauriSqlDatabase`; see the type above.
		const stillMatches: SqlDatabaseStillMatches = true;

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

		expect([...doubles.database.rows.keys()]).toEqual([]);
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

		expect(platform.secretSet("bittery_device_key", "dk")).rejects.toThrow(
			"Failed to write secrets.json",
		);
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
	// RecordPort — SQLite
	// ------------------------------------------------------------------

	test("initialize creates the table without depending on a Rust-side migration", async () => {
		const doubles = createTauriMobileDoubles();
		const record = createTauriMobileRecordPort(doubles.deps);

		expect(doubles.database.created).toBe(false);
		await record.initialize();

		expect(doubles.database.created).toBe(true);
		expect(doubles.database.executes[0]?.query).toBe(
			"CREATE TABLE IF NOT EXISTS records ( key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL )",
		);
	});

	test("records are stored one row per record under {collection}:{id}", async () => {
		const { record, doubles } = await makeMobilePorts();

		await record.recordPut("acct-1:items", "item-1", "blob");

		expect(doubles.database.rows.get("acct-1:items:item-1")).toBe("blob");
	});

	/**
	 * The O(1) proof. `vault-repository.ts` upserts one item at a time on delta sync, so a
	 * read-modify-write here would make a delta sync O(n^2).
	 */
	test("recordPut issues one upsert and never reads first", async () => {
		const { record, doubles } = await makeMobilePorts();
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
		const { record, doubles } = await makeMobilePorts();
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
		const { record, doubles } = await makeMobilePorts();
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
		const { record, doubles } = await makeMobilePorts();
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

	// ------------------------------------------------------------------
	// The prefix predicate — why it is not LIKE
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
