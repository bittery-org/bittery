/**
 * Chrome extension adapter conformance.
 *
 * The behavioural contract comes from the shared suite; this file only has to hand it a
 * fresh pair of ports backed by a faked `chrome.storage` plus the faked browser globals the
 * IndexedDB record port needs. The extra tests below pin the facts that are *specific* to
 * the extension and therefore invisible to a suite that must stay platform-agnostic: which
 * storage area backs which primitive, the `secretBacking` disclosure a security review
 * reads, and that session-bound values do not outlive a browser restart.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	type InstalledBrowserGlobals,
	type InstalledChromeStorage,
	installBrowserGlobals,
	installChromeStorage,
} from "./browser-test-doubles";
import { createChromePlatformPort, createChromeRecordPort } from "./chrome";
import { runPortConformance } from "./port-conformance";

let browser: InstalledBrowserGlobals | null = null;
let chromeStorage: InstalledChromeStorage | null = null;

/** Fresh, empty extension globals plus a fresh pair of ports, as the suite requires. */
async function makeChromePorts() {
	browser?.restore();
	chromeStorage?.restore();
	browser = installBrowserGlobals();
	chromeStorage = installChromeStorage();

	const platform = createChromePlatformPort();
	const record = createChromeRecordPort();
	await platform.initialize();
	await record.initialize();

	return { platform, record };
}

/** The installed `chrome.storage` areas, without a nullable dance in every test. */
function areas(): InstalledChromeStorage {
	if (chromeStorage === null) {
		throw new Error("chrome.storage was not installed");
	}
	return chromeStorage;
}

runPortConformance("chrome", makeChromePorts);

afterAll(() => {
	browser?.restore();
	chromeStorage?.restore();
	browser = null;
	chromeStorage = null;
});

describe("chrome adapter — platform-specific mapping", () => {
	test("declares itself as the extension with a session that dies with the browser", async () => {
		const { platform } = await makeChromePorts();

		expect(platform.platform).toBe("extension");
		expect(platform.sessionSurvivesRestart).toBe(false);
	});

	test("states plainly that the secret tier is not separated at rest", async () => {
		const { platform } = await makeChromePorts();

		expect(platform.secretBacking).toBe(
			"chrome.storage.local — NO at-rest separation from the plain tier; the browser profile is the trust boundary",
		);
	});

	test("has no biometric hardware", async () => {
		const { platform } = await makeChromePorts();

		expect(await platform.biometric.isAvailable()).toBe(false);
		expect(await platform.biometric.getType()).toBeNull();
		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "not_available",
		});
	});

	test("secrets and device-scope values land in chrome.storage.local", async () => {
		const { platform } = await makeChromePorts();

		await platform.secretSet("bittery_secret", "s");
		await platform.kvSet("bittery_setting", "d", "device");

		expect(await areas().local.get("bittery_secret")).toEqual({
			bittery_secret: "s",
		});
		expect(await areas().local.get("bittery_setting")).toEqual({
			bittery_setting: "d",
		});
		expect(await areas().session.get("bittery_secret")).toEqual({});
		expect(await areas().session.get("bittery_setting")).toEqual({});
	});

	test("session-scope values land in chrome.storage.session", async () => {
		const { platform } = await makeChromePorts();

		await platform.kvSet("bittery_jwt_token", "t", "session");

		expect(await areas().session.get("bittery_jwt_token")).toEqual({
			bittery_jwt_token: "t",
		});
		expect(await areas().local.get("bittery_jwt_token")).toEqual({});
	});

	test("values are stored as raw strings, not wrapped in an envelope", async () => {
		const { platform } = await makeChromePorts();

		await platform.secretSet("bittery_account_a_vault_keys", '[{"id":"v1"}]');

		const stored = await areas().local.get("bittery_account_a_vault_keys");
		expect(stored.bittery_account_a_vault_keys).toBe('[{"id":"v1"}]');
	});

	test("session-bound secrets do not survive a browser restart; device ones do", async () => {
		const { platform } = await makeChromePorts();

		// What AccountStore routes to `session` scope for a session-bound value.
		await platform.kvSet("bittery_account_a_vault_keys", "keys", "session");
		await platform.kvSet("bittery_account_a_jwt_token", "token", "session");
		await platform.kvSet("bittery_account_a_session_data", "blob", "device");

		// A browser restart clears chrome.storage.session and keeps chrome.storage.local.
		await areas().session.clear();
		const restarted = createChromePlatformPort();

		expect(
			await restarted.kvGet("bittery_account_a_vault_keys", "session"),
		).toBeNull();
		expect(
			await restarted.kvGet("bittery_account_a_jwt_token", "session"),
		).toBeNull();
		expect(
			await restarted.kvGet("bittery_account_a_session_data", "device"),
		).toBe("blob");
	});

	test("records survive a fresh record port over the same database", async () => {
		const { record } = await makeChromePorts();

		await record.recordPut("acct-1:items", "item-1", "blob");

		const reopened = createChromeRecordPort();
		await reopened.initialize();

		expect(await reopened.recordGet("acct-1:items", "item-1")).toBe("blob");
	});
});
