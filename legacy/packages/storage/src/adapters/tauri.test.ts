/**
 * Tauri desktop adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a
 * fresh pair of ports backed by faked Tauri modules. The extra tests below pin the facts
 * that are *specific* to desktop and therefore invisible to a suite that must stay
 * platform-agnostic: that secrets go to the OS keychain rather than `store.json`, that
 * device-scope keys are written bare so Rust can read them, the `record:` key layout and its
 * O(1) upsert, the `store.save()` durability rule, the biometric error mapping, and that the
 * port issues no IPC beyond its own three keychain commands.
 */

import { describe, expect, test } from "bun:test";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import { cachedItem } from "@bittery/shared/testing/item-fixtures";
import { createAccountStore } from "../account-store";
import { createItemCache } from "../item-cache";
import { runPortConformance } from "./port-conformance";
import { createTauriPlatformPort, createTauriRecordPort } from "./tauri";
import { createTauriDoubles, type TauriDoubles } from "./tauri-test-doubles";

/** Fresh, empty Tauri doubles plus a fresh pair of ports, as the suite requires. */
async function makeTauriPorts() {
	const doubles = createTauriDoubles();
	const platform = createTauriPlatformPort(doubles.deps);
	const record = createTauriRecordPort(doubles.deps);
	await platform.initialize();
	await record.initialize();

	return { platform, record, doubles };
}

runPortConformance("tauri", makeTauriPorts);

/** A platform port over doubles whose biometry plugin is configured up front. */
async function makeBiometricPort(configure: (doubles: TauriDoubles) => void) {
	const doubles = createTauriDoubles();
	configure(doubles);
	const platform = createTauriPlatformPort(doubles.deps);
	await platform.initialize();
	return { platform, doubles };
}

describe("tauri adapter — platform-specific mapping", () => {
	test("declares itself as desktop with a session that survives a restart", async () => {
		const { platform } = await makeTauriPorts();

		expect(platform.platform).toBe("desktop");
		expect(platform.sessionSurvivesRestart).toBe(true);
	});

	test("states that the secret tier is backed by the OS keychain", async () => {
		const { platform } = await makeTauriPorts();

		expect(platform.secretBacking).toBe(
			"OS keychain (macOS Keychain / Windows Credential Manager / libsecret) via Tauri keychain_* commands",
		);
	});

	test("secrets go to the keychain with no plaintext mirror in store.json", async () => {
		const { platform, doubles } = await makeTauriPorts();

		await platform.secretSet("bittery_device_key", "dk");

		expect(doubles.keychain.entries.get("bittery_device_key")).toBe("dk");
		expect(await platform.kvGet("bittery_device_key", "device")).toBeNull();
		expect([...doubles.store.contents.keys()]).toEqual([]);
	});

	test("publishes the record key prefix Rust prefix-scans store.json with", async () => {
		const { platform, record, doubles } = await makeTauriPorts();

		expect(platform.recordKeyPrefix).toBe("record:");

		await record.recordPut("acct-a:items", "item-1", "cipher");

		// The half of the contract a platform-agnostic suite cannot state: the key really
		// is discoverable under the prefix ItemCache writes into its native-view metadata.
		const prefix = `${platform.recordKeyPrefix}acct-a:items:`;
		expect(
			[...doubles.store.contents.keys()].filter((key) =>
				key.startsWith(prefix),
			),
		).toEqual([`${prefix}item-1`]);
	});

	test("publishes a cache-state ref whose promoted prefix follows the active generation", async () => {
		const { platform, record, doubles } = await makeTauriPorts();
		const accountStore = createAccountStore({
			port: platform,
			crypto: createInMemoryCryptoPort(),
		});
		const cache = createItemCache({ port: record });
		await accountStore.initialize();
		await cache.initialize();
		await accountStore.addAccount({
			accountId: "acct-a",
			email: "alice@example.com",
			userId: "user-a",
			name: "Alice",
			serverUrl: "https://app.bittery.io",
			secretKeyHint: "ABCD••••",
			addedAt: 1,
			lastActiveAt: 1,
			biometricEnabled: false,
			insecureTransportConfirmed: false,
		});

		const nativeView = JSON.parse(
			(await platform.kvGet("bittery_native_view", "device")) ?? "{}",
		) as {
			accounts?: Array<{ itemCacheState?: { key?: string } }>;
		};
		const stateKey = nativeView.accounts?.[0]?.itemCacheState?.key;
		expect(stateKey).toBe("record:acct-a:meta:meta");

		const stage = await cache.beginStagedGeneration("acct-a");
		await stage.promote({ lastFullSyncAt: 42, cacheVersion: 1 });

		const state = JSON.parse(
			String(doubles.store.contents.get(stateKey ?? "")),
		) as {
			activeGeneration?: string;
			nativeView?: { itemsKeyPrefix?: string; vaultsKeyPrefix?: string };
		};
		expect(state.nativeView?.itemsKeyPrefix).toBe(
			`record:item-cache-stage:acct-a:${state.activeGeneration}:items:`,
		);
		expect(state.nativeView?.vaultsKeyPrefix).toBe(
			`record:item-cache-stage:acct-a:${state.activeGeneration}:vaults:`,
		);
	});

	test("device-scope keys are written bare, so Rust can read them", async () => {
		const { platform, doubles } = await makeTauriPorts();

		await platform.kvSet("bittery_native_view", '{"v":1}', "device");

		expect(doubles.store.contents.get("bittery_native_view")).toBe('{"v":1}');
	});

	test("session-scope keys are namespaced away from device-scope keys", async () => {
		const { platform, doubles } = await makeTauriPorts();

		await platform.kvSet("bittery_jwt_token", "t", "session");

		expect(doubles.store.contents.get("session:bittery_jwt_token")).toBe("t");
		expect(doubles.store.contents.has("bittery_jwt_token")).toBe(false);
		// kvListKeys reports the logical key, not the namespaced one.
		expect(await platform.kvListKeys("bittery_")).toEqual([
			"bittery_jwt_token",
		]);
	});

	test("kvListKeys does not report the record port's keys", async () => {
		const { platform, record } = await makeTauriPorts();

		await record.recordPut("acct-1:items", "item-1", "blob");
		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);

		expect(await platform.kvListKeys("")).toEqual(["bittery_server_url"]);
	});

	test("records are stored one key per record under record:{collection}:{id}", async () => {
		const { record, doubles } = await makeTauriPorts();

		await record.recordPut("acct-1:items", "item-1", "blob");

		expect(doubles.store.contents.get("record:acct-1:items:item-1")).toBe(
			"blob",
		);
	});

	test("recordPut is O(1) — one set on one key, whatever the collection holds", async () => {
		const { record, doubles } = await makeTauriPorts();
		for (let index = 0; index < 100; index += 1) {
			await record.recordPut("acct-1:items", `item-${index}`, "blob");
		}
		doubles.store.resetCallLog();

		await record.recordPut("acct-1:items", "item-50", "updated");

		expect(doubles.store.sets).toEqual([
			["record:acct-1:items:item-50", "updated"],
		]);
		expect(await record.recordList("acct-1:items")).toHaveLength(100);
	});

	test("recordDelete is O(1) — one delete on one key", async () => {
		const { record, doubles } = await makeTauriPorts();
		await record.recordPut("acct-1:items", "item-1", "blob");
		await record.recordPut("acct-1:items", "item-2", "blob");
		doubles.store.resetCallLog();

		await record.recordDelete("acct-1:items", "item-1");

		expect(doubles.store.deletes).toEqual(["record:acct-1:items:item-1"]);
		expect(doubles.store.sets).toEqual([]);
	});

	// ------------------------------------------------------------------
	// Durability — store.save() is an fsync
	// ------------------------------------------------------------------

	test("every mutating call flushes before it resolves", async () => {
		const { platform, record, doubles } = await makeTauriPorts();
		doubles.store.resetCallLog();

		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);
		expect(doubles.store.saves).toBe(1);

		await platform.kvDelete("bittery_server_url", "device");
		expect(doubles.store.saves).toBe(2);

		await record.recordPut("acct-1:items", "item-1", "blob");
		expect(doubles.store.saves).toBe(3);

		await record.recordDelete("acct-1:items", "item-1");
		expect(doubles.store.saves).toBe(4);
	});

	test("reads never flush", async () => {
		const { platform, record, doubles } = await makeTauriPorts();
		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);
		await record.recordPut("acct-1:items", "item-1", "blob");
		doubles.store.resetCallLog();

		await platform.kvGet("bittery_server_url", "device");
		await platform.kvListKeys("bittery_");
		await record.recordGet("acct-1:items", "item-1");
		await record.recordList("acct-1:items");

		expect(doubles.store.saves).toBe(0);
	});

	test("recordClear pays one fsync for N deletes", async () => {
		const { record, doubles } = await makeTauriPorts();
		for (let index = 0; index < 10; index += 1) {
			await record.recordPut("acct-1:items", `item-${index}`, "blob");
		}
		doubles.store.resetCallLog();

		await record.recordClear("acct-1:items");

		expect(doubles.store.deletes).toHaveLength(10);
		expect(doubles.store.saves).toBe(1);
	});

	test("recordList reads the whole collection in one call, not one get per record", async () => {
		const { record, doubles } = await makeTauriPorts();
		await record.recordPutMany(
			"acct-1:items",
			Array.from({ length: 20 }, (_unused, index) => ({
				id: `item-${index}`,
				value: `blob-${index}`,
			})),
		);
		doubles.store.resetCallLog();

		expect(await record.recordList("acct-1:items")).toHaveLength(20);
		expect(doubles.store.gets).toEqual([]);
	});

	test("recordPutMany pays one fsync for N writes", async () => {
		const { record, doubles } = await makeTauriPorts();
		const records = Array.from({ length: 10 }, (_unused, index) => ({
			id: `item-${index}`,
			value: `blob-${index}`,
		}));
		doubles.store.resetCallLog();

		await record.recordPutMany("acct-1:items", records);

		expect(doubles.store.sets).toHaveLength(10);
		expect(doubles.store.saves).toBe(1);
		expect(await record.recordList("acct-1:items")).toHaveLength(10);
	});

	/**
	 * The reason this matters: a full bootstrap copies the baseline, re-stages every
	 * item and reconciles on promote. One fsync per record made deleting a vault cost
	 * thousands of `store.save()` calls at 27-77ms each, which froze the dialog awaiting
	 * it. The fsync bill for a refresh must depend on the number of *phases*, not on the
	 * number of items.
	 */
	async function stagedRefreshFsyncs(itemCount: number): Promise<number> {
		const { record, doubles } = await makeTauriPorts();
		const cache = createItemCache({ port: record });
		await cache.initialize();
		const items = Array.from({ length: itemCount }, (_unused, index) =>
			cachedItem({ id: `item-${index}`, vaultId: "vault-1" }),
		);
		await cache.setCachedItems(items, "acct-a");
		doubles.store.resetCallLog();

		const stage = await cache.beginStagedGeneration("acct-a");
		await stage.upsertCachedItems(items);
		await stage.promote({ lastFullSyncAt: 1, cacheVersion: 1 });

		return doubles.store.saves;
	}

	test("a staged refresh pays the same fsyncs whatever the cache holds", async () => {
		expect(await stagedRefreshFsyncs(40)).toBe(await stagedRefreshFsyncs(10));
	});

	test("a 324-item staged refresh uses 19 store IPC calls", async () => {
		const { record, doubles } = await makeTauriPorts();
		const cache = createItemCache({ port: record });
		await cache.initialize();
		const items = Array.from({ length: 324 }, (_unused, index) =>
			cachedItem({ id: `item-${index}`, vaultId: "vault-1" }),
		);
		await cache.setCachedItems(items, "acct-a");
		doubles.store.resetCallLog();

		const stage = await cache.beginStagedGeneration("acct-a");
		await stage.upsertCachedItems(items);
		await stage.promote({ lastFullSyncAt: 1, cacheVersion: 1 });

		expect(doubles.store.ipcCalls).toBe(19);
	});

	// ------------------------------------------------------------------
	// IPC surface
	// ------------------------------------------------------------------

	test("the port issues no IPC beyond its own three keychain commands", async () => {
		const { platform, record, doubles } = await makeTauriPorts();

		await platform.secretSet("bittery_device_key", "dk");
		await platform.secretGet("bittery_device_key");
		await platform.secretDelete("bittery_device_key");
		await platform.kvSet("bittery_active_account", "a", "device");
		await platform.kvDelete("bittery_active_account", "device");
		await record.recordPut("acct-1:items", "item-1", "blob");
		await record.recordClear("acct-1:items");

		expect([
			...new Set(doubles.keychain.calls.map((call) => call.cmd)),
		]).toEqual(["keychain_set", "keychain_get", "keychain_delete"]);
	});

	test("a keychain backend that throws for a missing entry still reads as absent", async () => {
		const { platform, doubles } = await makeTauriPorts();
		doubles.keychain.failNextGet = new Error("No such keychain entry");

		expect(await platform.secretGet("bittery_device_key")).toBeNull();
	});

	test("a keychain backend that throws on delete is still a no-op, not a throw", async () => {
		const { platform, doubles } = await makeTauriPorts();
		doubles.keychain.failDelete = "SecItemDelete failed";

		await platform.secretDelete("bittery_device_key");
	});

	test("store.json and the keychain survive a fresh pair of ports", async () => {
		const doubles = createTauriDoubles();
		const platform = createTauriPlatformPort(doubles.deps);
		const record = createTauriRecordPort(doubles.deps);
		await platform.initialize();
		await record.initialize();
		await platform.secretSet("bittery_device_key", "dk");
		await platform.kvSet("bittery_active_account", "a", "device");
		await record.recordPut("acct-1:items", "item-1", "blob");

		const restarted = createTauriPlatformPort(doubles.deps);
		const restartedRecords = createTauriRecordPort(doubles.deps);
		await restarted.initialize();
		await restartedRecords.initialize();

		expect(await restarted.secretGet("bittery_device_key")).toBe("dk");
		expect(await restarted.kvGet("bittery_active_account", "device")).toBe("a");
		expect(await restartedRecords.recordGet("acct-1:items", "item-1")).toBe(
			"blob",
		);
	});
});

describe("tauri adapter — biometric", () => {
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

	test("reports no hardware when the device has none", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.biometry.status = {
				isAvailable: false,
				biometryType: 0,
				errorCode: "biometryNotAvailable",
			};
		});

		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: false,
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

	test("an uninstalled biometry plugin is honestly unavailable, never a throw", async () => {
		const doubles = createTauriDoubles({ biometryModuleMissing: true });
		const platform = createTauriPlatformPort(doubles.deps);
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
});
