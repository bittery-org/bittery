/**
 * React Native mobile adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a
 * fresh pair of ports backed by faked Expo modules. The extra tests below pin the facts that
 * are *specific* to mobile and therefore invisible to a suite that must stay
 * platform-agnostic: the sqlite table layout and its O(1) record access, the `session:`
 * namespace, the biometric error mapping, and the SecureStore chunking.
 *
 * `SecureStoreDouble` enforces the real ~2048-byte Android limit, so every oversized-secret
 * test below fails loudly if chunking is ever removed or weakened back into demotion.
 */

import { describe, expect, test } from "bun:test";
import { runPortConformance } from "./port-conformance";
import {
	createReactNativePlatformPort,
	createReactNativeRecordPort,
} from "./react-native";
import {
	AUTHENTICATION_TYPE,
	createReactNativeDoubles,
	type ReactNativeDoubles,
} from "./react-native-test-doubles";

/** Fresh, empty Expo doubles plus a fresh pair of ports, as the suite requires. */
async function makeReactNativePorts() {
	const doubles = createReactNativeDoubles();
	const platform = createReactNativePlatformPort(doubles.deps);
	const record = createReactNativeRecordPort(doubles.deps);
	await platform.initialize();
	await record.initialize();

	return { platform, record, doubles };
}

runPortConformance("react-native", makeReactNativePorts);

/** A platform port over doubles whose local-authentication module is configured up front. */
async function makeBiometricPort(
	configure: (doubles: ReactNativeDoubles) => void,
) {
	const doubles = createReactNativeDoubles();
	configure(doubles);
	const platform = createReactNativePlatformPort(doubles.deps);
	await platform.initialize();
	return { platform, doubles };
}

/** UTF-8 byte length, which is what the store limit and the chunk threshold measure. */
function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/** The adapter's constants, restated here so a change to either has to be deliberate. */
const CHUNK_THRESHOLD_BYTES = 1800;
const CHUNK_PAYLOAD_BYTES = 1350;
const MANIFEST_PREFIX = "__bittery_chunked_secret_v1__:";

describe("react-native adapter — platform-specific mapping", () => {
	test("declares itself as mobile with a session that survives a restart", async () => {
		const { platform } = await makeReactNativePorts();

		expect(platform.platform).toBe("mobile");
		expect(platform.sessionSurvivesRestart).toBe(true);
	});

	test("states that the secret tier is backed by the OS secure store, chunked", async () => {
		const { platform } = await makeReactNativePorts();

		expect(platform.secretBacking).toBe(
			"expo-secure-store (iOS Keychain / Android Keystore-backed EncryptedSharedPreferences), chunked for values over the platform size limit",
		);
	});

	test("kv values go to the kv_store table, keyed bare at device scope", async () => {
		const { platform, doubles } = await makeReactNativePorts();

		await platform.kvSet("bittery_active_account", "acct-1", "device");

		expect(doubles.database.rows("kv_store")).toEqual([
			{ key: "bittery_active_account", value: "acct-1" },
		]);
	});

	test("session-scope keys are namespaced away from device-scope keys", async () => {
		const { platform, doubles } = await makeReactNativePorts();

		await platform.kvSet("bittery_jwt_token", "t", "session");

		expect(doubles.database.rows("kv_store")).toEqual([
			{ key: "session:bittery_jwt_token", value: "t" },
		]);
		// kvListKeys reports the logical key, not the namespaced one.
		expect(await platform.kvListKeys("bittery_")).toEqual([
			"bittery_jwt_token",
		]);
	});

	test("kvListKeys prefix matching treats an underscore literally, not as a wildcard", async () => {
		const { platform } = await makeReactNativePorts();

		// `_` is a single-character wildcard in SQL LIKE. Without escaping, the prefix
		// `bittery_a` would also match `bitteryXa`.
		await platform.kvSet("bittery_active_account", "1", "device");
		await platform.kvSet("bitteryXactive_account", "2", "device");

		expect(await platform.kvListKeys("bittery_")).toEqual([
			"bittery_active_account",
		]);
	});

	test("kvListKeys does not report the record port's rows", async () => {
		const { platform, record } = await makeReactNativePorts();

		await record.recordPut("acct-1:items", "item-1", "blob");
		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);

		expect(await platform.kvListKeys("")).toEqual(["bittery_server_url"]);
	});

	test("records are one row per record in a dedicated table", async () => {
		const { record, doubles } = await makeReactNativePorts();

		await record.recordPut("acct-1:items", "item-1", "blob");

		expect(doubles.database.rows("records")).toEqual([
			{ collection: "acct-1:items", id: "item-1", value: "blob" },
		]);
	});

	test("recordPut is O(1) — one statement, whatever the collection holds", async () => {
		const { record, doubles } = await makeReactNativePorts();
		for (let index = 0; index < 100; index += 1) {
			await record.recordPut("acct-1:items", `item-${index}`, "blob");
		}
		doubles.database.resetCallLog();

		await record.recordPut("acct-1:items", "item-50", "updated");

		expect(doubles.database.statements).toEqual([
			"INSERT OR REPLACE INTO records (collection, id, value) VALUES (?, ?, ?)",
		]);
		expect(await record.recordList("acct-1:items")).toHaveLength(100);
		expect(await record.recordGet("acct-1:items", "item-50")).toBe("updated");
	});

	test("recordDelete is O(1) — one statement on one row", async () => {
		const { record, doubles } = await makeReactNativePorts();
		await record.recordPut("acct-1:items", "item-1", "blob");
		await record.recordPut("acct-1:items", "item-2", "blob");
		doubles.database.resetCallLog();

		await record.recordDelete("acct-1:items", "item-1");

		expect(doubles.database.statements).toEqual([
			"DELETE FROM records WHERE collection = ? AND id = ?",
		]);
		expect(await record.recordGet("acct-1:items", "item-2")).toBe("blob");
	});

	test("the two tables share one database and survive a fresh pair of ports", async () => {
		const doubles = createReactNativeDoubles();
		const platform = createReactNativePlatformPort(doubles.deps);
		const record = createReactNativeRecordPort(doubles.deps);
		await platform.initialize();
		await record.initialize();
		await platform.secretSet("bittery_device_key", "dk");
		await platform.kvSet("bittery_active_account", "a", "device");
		await record.recordPut("acct-1:items", "item-1", "blob");

		const restarted = createReactNativePlatformPort(doubles.deps);
		const restartedRecords = createReactNativeRecordPort(doubles.deps);
		await restarted.initialize();
		await restartedRecords.initialize();

		expect(await restarted.secretGet("bittery_device_key")).toBe("dk");
		expect(await restarted.kvGet("bittery_active_account", "device")).toBe("a");
		expect(await restartedRecords.recordGet("acct-1:items", "item-1")).toBe(
			"blob",
		);
	});

	test("a secure store that throws on read still answers absent, not a throw", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		doubles.secureStore.failNextGet = new Error("Keychain unavailable");

		expect(await platform.secretGet("bittery_device_key")).toBeNull();
	});

	test("a secure store that throws on delete is still a no-op, not a throw", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		doubles.secureStore.failDelete = "SecItemDelete failed";

		await platform.secretDelete("bittery_device_key");
	});

	test("an uninstalled secure store reads as absent rather than throwing", async () => {
		const doubles = createReactNativeDoubles({
			secureStoreModuleMissing: true,
		});
		const platform = createReactNativePlatformPort(doubles.deps);

		expect(await platform.secretGet("bittery_device_key")).toBeNull();
		await platform.secretDelete("bittery_device_key");
	});

	test("a secret write that cannot reach the secure store fails loudly", async () => {
		const doubles = createReactNativeDoubles({
			secureStoreModuleMissing: true,
		});
		const platform = createReactNativePlatformPort(doubles.deps);

		// Losing a secret silently would be worse than a loud failure, so write is the one
		// primitive that must not swallow its error.
		expect(platform.secretSet("bittery_vault_keys", "keys")).rejects.toThrow();
	});
});

// ============================================================================
// SecureStore chunking — the central fix
// ============================================================================

describe("react-native adapter — SecureStore chunking", () => {
	test("a secret never lands in sqlite, however large it is", async () => {
		const { platform, doubles } = await makeReactNativePorts();

		// Tier decides placement; size never does, however large the secret.
		await platform.secretSet("bittery_vault_keys", "k".repeat(50_000));

		expect(doubles.database.rows("kv_store")).toEqual([]);
		expect(await platform.secretGet("bittery_vault_keys")).toBe(
			"k".repeat(50_000),
		);
	});

	test("no single stored item exceeds what the platform accepts", async () => {
		const { platform, doubles } = await makeReactNativePorts();

		await platform.secretSet("bittery_vault_keys", "k".repeat(50_000));

		// The double throws above 2048 bytes exactly as Android does, so reaching here is
		// already proof — but state the invariant so a failure reads clearly.
		for (const value of doubles.secureStore.entries.values()) {
			expect(byteLength(value)).toBeLessThanOrEqual(CHUNK_THRESHOLD_BYTES);
		}
	});

	test("a value exactly at the threshold is written whole, with no manifest", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		const value = "a".repeat(CHUNK_THRESHOLD_BYTES);

		await platform.secretSet("s:edge", value);

		expect(doubles.secureStore.entries.get("s:edge")).toBe(value);
		expect(doubles.secureStore.chunkKeysFor("s:edge")).toEqual([]);
		expect(await platform.secretGet("s:edge")).toBe(value);
	});

	test("a value one byte over the threshold is chunked", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		const value = "a".repeat(CHUNK_THRESHOLD_BYTES + 1);

		await platform.secretSet("s:edge", value);

		expect(doubles.secureStore.entries.get("s:edge")).toBe(
			`${MANIFEST_PREFIX}2`,
		);
		expect(doubles.secureStore.chunkKeysFor("s:edge")).toEqual([
			"s:edge.c0",
			"s:edge.c1",
		]);
		expect(await platform.secretGet("s:edge")).toBe(value);
	});

	test("the threshold counts UTF-8 bytes, not JS string length", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		// 900 two-byte characters: 900 JS characters but 1800 bytes — right at the limit,
		// and 901 of them would overflow a native store that a `.length` check waved past.
		const value = "é".repeat(901);
		expect(value.length).toBeLessThan(CHUNK_THRESHOLD_BYTES);
		expect(byteLength(value)).toBeGreaterThan(CHUNK_THRESHOLD_BYTES);

		await platform.secretSet("s:multibyte", value);

		expect(doubles.secureStore.entries.get("s:multibyte")).toBe(
			`${MANIFEST_PREFIX}2`,
		);
		expect(await platform.secretGet("s:multibyte")).toBe(value);
	});

	test("a large multi-byte value round-trips without splitting a codepoint", async () => {
		const { platform } = await makeReactNativePorts();
		// Four-byte codepoints, so every chunk boundary lands mid-character unless the
		// split happens on the encoded bytes and is only decoded once reassembled.
		const value = "🔐é中a".repeat(1000);
		expect(byteLength(value)).toBeGreaterThan(CHUNK_PAYLOAD_BYTES * 5);

		await platform.secretSet("s:emoji", value);

		expect(await platform.secretGet("s:emoji")).toBe(value);
		expect(await platform.secretGet("s:emoji")).not.toContain("�");
	});

	test("overwriting large with small leaves no orphan chunks behind", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		await platform.secretSet("s:big", "x".repeat(20_000));
		expect(doubles.secureStore.chunkKeysFor("s:big").length).toBeGreaterThan(
			10,
		);

		await platform.secretSet("s:big", "tiny");

		expect(doubles.secureStore.chunkKeysFor("s:big")).toEqual([]);
		expect([...doubles.secureStore.entries.keys()]).toEqual(["s:big"]);
		expect(await platform.secretGet("s:big")).toBe("tiny");
	});

	test("overwriting large with a smaller large value drops the surplus chunks", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		await platform.secretSet("s:big", "x".repeat(20_000));

		const smaller = "y".repeat(CHUNK_PAYLOAD_BYTES * 2 + 10);
		await platform.secretSet("s:big", smaller);

		expect(doubles.secureStore.chunkKeysFor("s:big")).toEqual([
			"s:big.c0",
			"s:big.c1",
			"s:big.c2",
		]);
		expect(await platform.secretGet("s:big")).toBe(smaller);
	});

	test("overwriting small with large is invisible above the port", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		await platform.secretSet("s:grow", "tiny");

		const value = "z".repeat(9000);
		await platform.secretSet("s:grow", value);

		expect(doubles.secureStore.entries.get("s:grow")).toBe(
			`${MANIFEST_PREFIX}7`,
		);
		expect(await platform.secretGet("s:grow")).toBe(value);
	});

	test("secretDelete removes the manifest and every chunk", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		await platform.secretSet("s:big", "x".repeat(20_000));
		await platform.secretSet("s:other", "keep me");

		await platform.secretDelete("s:big");

		expect([...doubles.secureStore.entries.keys()]).toEqual(["s:other"]);
		expect(await platform.secretGet("s:big")).toBeNull();
	});

	test("a torn write reads as absent rather than as a truncated secret", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		const value = "x".repeat(20_000);
		await platform.secretSet("s:torn", value);

		// Lose one chunk behind the port's back, as an interrupted write or a partially
		// wiped keychain would. Returning the surviving prefix would hand a caller a
		// silently corrupt key.
		doubles.secureStore.entries.delete("s:torn.c3");

		expect(await platform.secretGet("s:torn")).toBeNull();
	});

	test("a manifest with a missing final chunk is absent, not short", async () => {
		const { platform, doubles } = await makeReactNativePorts();
		await platform.secretSet("s:torn", "x".repeat(20_000));
		const chunks = doubles.secureStore.chunkKeysFor("s:torn");
		const last = chunks.at(-1);
		expect(last).toBeDefined();

		doubles.secureStore.entries.delete(last ?? "");

		expect(await platform.secretGet("s:torn")).toBeNull();
	});

	test("a value that merely looks like a manifest is returned verbatim", async () => {
		const { platform } = await makeReactNativePorts();

		// Not a real risk — no value AccountStore stores can start with the marker — but
		// the failure mode must be "returned as written", never "parsed as a manifest".
		await platform.secretSet("s:odd", `${MANIFEST_PREFIX}not-a-number`);

		expect(await platform.secretGet("s:odd")).toBe(
			`${MANIFEST_PREFIX}not-a-number`,
		);
	});

	test("chunked and unchunked secrets do not disturb each other", async () => {
		const { platform } = await makeReactNativePorts();

		await platform.secretSet("s:a", "small");
		await platform.secretSet("s:a-big", "q".repeat(9000));
		await platform.secretSet("s:b", "");

		expect(await platform.secretGet("s:a")).toBe("small");
		expect(await platform.secretGet("s:a-big")).toBe("q".repeat(9000));
		expect(await platform.secretGet("s:b")).toBe("");
	});
});

// ============================================================================
// Biometric
// ============================================================================

describe("react-native adapter — biometric", () => {
	test("reports availability from hardware plus enrolment", async () => {
		const { platform } = await makeBiometricPort(() => {});

		expect(await platform.biometric.isAvailable()).toBe(true);
		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: true,
			isEnrolled: true,
		});
	});

	test("hardware present but nothing enrolled is not available", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.isEnrolled = false;
		});

		expect(await platform.biometric.isAvailable()).toBe(false);
		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: true,
			isEnrolled: false,
		});
	});

	test("reports the supported authentication type", async () => {
		const face = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.supportedTypes = [
				AUTHENTICATION_TYPE.FACIAL_RECOGNITION,
			];
		});
		const finger = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.supportedTypes = [
				AUTHENTICATION_TYPE.FINGERPRINT,
			];
		});
		const neither = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.supportedTypes = [AUTHENTICATION_TYPE.IRIS];
		});

		expect(await face.platform.biometric.getType()).toBe("face");
		expect(await finger.platform.biometric.getType()).toBe("fingerprint");
		expect(await neither.platform.biometric.getType()).toBeNull();
	});

	test("a successful prompt reports success and passes the reason through", async () => {
		const { platform, doubles } = await makeBiometricPort(() => {});

		expect(await platform.biometric.authenticate("Unlock your vault")).toEqual({
			success: true,
		});
		// No `cancelLabel` / `fallbackLabel`: hardcoded English here would sit below the
		// i18n seam. Omitting them lets iOS and Android render their own localised labels.
		expect(doubles.localAuthentication.prompts).toEqual([
			{
				promptMessage: "Unlock your vault",
				disableDeviceFallback: false,
			},
		]);
	});

	for (const [native, mapped] of [
		["user_cancel", "user_cancelled"],
		["lockout", "lockout"],
		["lockout_permanent", "lockout"],
		["not_enrolled", "not_enrolled"],
		["not_available", "not_available"],
		["authentication_failed", "failed"],
		["system_cancel", "failed"],
		["unknown", "failed"],
	] as const) {
		test(`maps the native error "${native}" to "${mapped}"`, async () => {
			const { platform } = await makeBiometricPort((doubles) => {
				doubles.localAuthentication.result = { success: false, error: native };
			});

			// The native code is carried through in `message` untouched — a bare boolean
			// would collapse "the user pressed cancel" into "authentication failed".
			expect(await platform.biometric.authenticate("unlock")).toEqual({
				success: false,
				error: mapped,
				message: native,
			});
		});
	}

	test("a failure with no native code is a plain failure", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.result = { success: false };
		});

		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "failed",
			message: "unknown",
		});
	});

	test("a native bridge that throws is a failure, never a throw", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.authFailure = new Error("Bridge died");
		});

		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "failed",
			message: "Bridge died",
		});
	});

	test("a probe that throws is honestly unavailable", async () => {
		const { platform } = await makeBiometricPort((doubles) => {
			doubles.localAuthentication.probeFailure = new Error("No native module");
		});

		expect(await platform.biometric.isAvailable()).toBe(false);
		expect(await platform.biometric.getType()).toBeNull();
		expect(await platform.biometric.getDetails()).toEqual({
			hasHardware: false,
			isEnrolled: false,
		});
	});

	test("an uninstalled module is honestly unavailable, never a throw", async () => {
		const doubles = createReactNativeDoubles({
			localAuthenticationModuleMissing: true,
		});
		const platform = createReactNativePlatformPort(doubles.deps);
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
