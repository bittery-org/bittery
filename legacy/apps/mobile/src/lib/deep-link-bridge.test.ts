/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
	buildDeviceSetupLinkUri,
	buildDeviceSetupQrUri,
} from "@bittery/shared/device-setup";
import { resolveDeepLink } from "./deep-link-bridge";

describe("resolveDeepLink", () => {
	test("routes autofill-unlock to the unlock screen", () => {
		const url = "bittery://autofill-unlock?passwordRequired=true";
		expect(resolveDeepLink(url)).toEqual({
			to: "/unlock",
			search: { autoTrigger: true, autoTriggerId: url },
		});
	});

	test("routes a desktop setup QR onto login as an add-account visit", () => {
		const url = buildDeviceSetupQrUri({
			email: "julian@uxcrew.de",
			serverUrl: "https://api.bittery.com",
			secretKey: "A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G",
			teamName: "UX Crew",
		});

		expect(resolveDeepLink(url)).toEqual({
			to: "/login",
			search: {
				addAccount: true,
				setup: "1",
				v: "1",
				email: "julian@uxcrew.de",
				serverUrl: "https://api.bittery.com",
				teamName: "UX Crew",
				secretKey: "A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G",
			},
		});
	});

	test("routes a setup link that has no Secret Key", () => {
		const url = buildDeviceSetupLinkUri({
			email: "julian@uxcrew.de",
			serverUrl: "https://api.bittery.com",
		});

		expect(resolveDeepLink(url)).toEqual({
			to: "/login",
			search: {
				addAccount: true,
				setup: "1",
				v: "1",
				email: "julian@uxcrew.de",
				serverUrl: "https://api.bittery.com",
				teamName: undefined,
				secretKey: undefined,
			},
		});
	});

	test("ignores junk and unknown bittery hosts", () => {
		expect(resolveDeepLink("not a url")).toBeNull();
		expect(resolveDeepLink("https://example.com")).toBeNull();
		expect(resolveDeepLink("bittery://vault/abc")).toBeNull();
		expect(resolveDeepLink("bittery://login?email=a@b.com")).toBeNull();
	});
});
