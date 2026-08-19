/**
 * Web adapter conformance.
 *
 * The whole behavioural contract comes from the shared suite; this file only has to hand
 * it a fresh pair of ports backed by faked browser globals. The handful of extra tests
 * below pin the facts that are *specific* to web and therefore invisible to a suite that
 * must stay platform-agnostic: which browser API backs which primitive, and the
 * `secretBacking` disclosure a security review reads.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	type InstalledBrowserGlobals,
	installBrowserGlobals,
} from "./browser-test-doubles";
import { runPortConformance } from "./port-conformance";
import { createWebPlatformPort, createWebRecordPort } from "./web";

let installed: InstalledBrowserGlobals | null = null;

/** Fresh, empty browser globals plus a fresh pair of ports, as the suite requires. */
async function makeWebPorts() {
	installed?.restore();
	installed = installBrowserGlobals();

	const platform = createWebPlatformPort();
	const record = createWebRecordPort();
	await platform.initialize();
	await record.initialize();

	return { platform, record };
}

runPortConformance("web", makeWebPorts);

afterAll(() => {
	installed?.restore();
	installed = null;
});

describe("web adapter — platform-specific mapping", () => {
	test("declares itself as web with a session that dies with the tab", async () => {
		const { platform } = await makeWebPorts();

		expect(platform.platform).toBe("web");
		expect(platform.sessionSurvivesRestart).toBe(false);
	});

	test("states plainly that the secret tier is not separated at rest", async () => {
		const { platform } = await makeWebPorts();

		expect(platform.secretBacking).toBe(
			"localStorage — NO at-rest separation from the plain tier; the browser profile is the trust boundary",
		);
	});

	test("has no biometric hardware", async () => {
		const { platform } = await makeWebPorts();

		expect(await platform.biometric.isAvailable()).toBe(false);
		expect(await platform.biometric.getType()).toBeNull();
		expect(await platform.biometric.authenticate("unlock")).toEqual({
			success: false,
			error: "not_available",
		});
	});

	test("secrets and device-scope values land in localStorage", async () => {
		const { platform } = await makeWebPorts();
		const globals = installed;
		if (globals === null) {
			throw new Error("globals were not installed");
		}

		await platform.secretSet("bittery_secret", "s");
		await platform.kvSet("bittery_setting", "d", "device");

		expect(globals.localStorage.getItem("bittery_secret")).toBe("s");
		expect(globals.localStorage.getItem("bittery_setting")).toBe("d");
		expect(globals.sessionStorage.getItem("bittery_secret")).toBeNull();
		expect(globals.sessionStorage.getItem("bittery_setting")).toBeNull();
	});

	test("session-scope values land in sessionStorage", async () => {
		const { platform } = await makeWebPorts();
		const globals = installed;
		if (globals === null) {
			throw new Error("globals were not installed");
		}

		await platform.kvSet("bittery_jwt_token", "t", "session");

		expect(globals.sessionStorage.getItem("bittery_jwt_token")).toBe("t");
		expect(globals.localStorage.getItem("bittery_jwt_token")).toBeNull();
	});

	test("session-scope values do not survive a new tab, device-scope ones do", async () => {
		const { platform } = await makeWebPorts();
		const globals = installed;
		if (globals === null) {
			throw new Error("globals were not installed");
		}

		await platform.kvSet("bittery_jwt_token", "t", "session");
		await platform.kvSet(
			"bittery_server_url",
			"https://example.test",
			"device",
		);

		// A new tab keeps localStorage and starts sessionStorage empty.
		globals.sessionStorage.clear();
		const reopened = createWebPlatformPort();

		expect(await reopened.kvGet("bittery_jwt_token", "session")).toBeNull();
		expect(await reopened.kvGet("bittery_server_url", "device")).toBe(
			"https://example.test",
		);
	});

	test("records survive a fresh record port over the same database", async () => {
		const { record } = await makeWebPorts();

		await record.recordPut("acct-1:items", "item-1", "blob");

		const reopened = createWebRecordPort();
		await reopened.initialize();

		expect(await reopened.recordGet("acct-1:items", "item-1")).toBe("blob");
	});
});
