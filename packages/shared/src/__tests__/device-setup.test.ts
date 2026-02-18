import { describe, expect, test } from "bun:test";
import {
	buildDeviceSetupLinkUri,
	buildDeviceSetupQrUri,
	parseDeviceSetupParams,
	parseDeviceSetupUri,
} from "../device-setup";

describe("device setup URI helpers", () => {
	const payload = {
		email: "Julian@UXCrew.de",
		serverUrl: "api.bittery.com",
		teamName: "UX Crew",
	};

	test("builds and parses QR payload with secret key", () => {
		const uri = buildDeviceSetupQrUri({
			...payload,
			secretKey: "a3-73asv5-lcmrcu-b7tmm-vmh3k-qc27g",
		});

		const parsed = parseDeviceSetupUri(uri);
		expect(parsed.version).toBe("1");
		expect(parsed.email).toBe("julian@uxcrew.de");
		expect(parsed.serverUrl).toBe("https://api.bittery.com");
		expect(parsed.teamName).toBe("UX Crew");
		expect(parsed.secretKey).toBe("A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G");
	});

	test("builds link payload without secret key", () => {
		const uri = buildDeviceSetupLinkUri(payload);
		expect(uri.includes("secretKey=")).toBe(false);

		const parsed = parseDeviceSetupUri(uri);
		expect(parsed.secretKey).toBeUndefined();
		expect(parsed.email).toBe("julian@uxcrew.de");
		expect(parsed.serverUrl).toBe("https://api.bittery.com");
	});

	test("rejects unsupported routes", () => {
		expect(() => parseDeviceSetupUri("bittery://setup?setup=1&v=1")).toThrow(
			"Unsupported setup URI route",
		);
	});

	test("rejects invalid payload version", () => {
		expect(() =>
			parseDeviceSetupUri(
				"bittery://login?setup=1&v=2&email=test@example.com&serverUrl=https%3A%2F%2Fapi.bittery.com",
			),
		).toThrow("Unsupported setup payload version");
	});

	test("returns null for non-setup params", () => {
		const parsed = parseDeviceSetupParams({
			email: "test@example.com",
			serverUrl: "https://api.bittery.com",
		});
		expect(parsed).toBeNull();
	});

	test("parses setup params from route search values", () => {
		const parsed = parseDeviceSetupParams({
			setup: "1",
			v: "1",
			email: "test@example.com",
			serverUrl: "https://api.bittery.com/",
			secretKey: "A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G",
		});

		expect(parsed).not.toBeNull();
		expect(parsed?.email).toBe("test@example.com");
		expect(parsed?.serverUrl).toBe("https://api.bittery.com");
		expect(parsed?.secretKey).toBe("A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G");
	});
});
