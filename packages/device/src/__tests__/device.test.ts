import { describe, expect, test } from "bun:test";
import {
	formatDeviceDisplay,
	formatLastActive,
	getDesktopDeviceInfo,
	getExtensionDeviceInfo,
	parseUserAgent,
} from "../index";

const EDGE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0";
const OPERA_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0";
const BRAVE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Brave/1.75.175 Chrome/133.0.0.0 Safari/537.36";
const VIVALDI_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Vivaldi/6.9.3447.41 Chrome/128.0.0.0 Safari/537.36";
const IPHONE_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_UA =
	"Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("@bittery/device", () => {
	test("prefers Edge over Chrome", () => {
		const device = parseUserAgent(EDGE_UA);

		expect(device.browserName).toBe("Edge");
		expect(device.browserVersion).toBe("132.0.0");
	});

	test("preserves Opera, Brave, and Vivaldi precedence", () => {
		expect(parseUserAgent(OPERA_UA).browserName).toBe("Opera");
		expect(parseUserAgent(BRAVE_UA).browserName).toBe("Brave");
		expect(parseUserAgent(VIVALDI_UA).browserName).toBe("Vivaldi");
	});

	test("detects iPhone and iPad operating systems", () => {
		const iphone = parseUserAgent(IPHONE_UA);
		const ipad = parseUserAgent(IPAD_UA);

		expect(iphone.osName).toBe("iOS");
		expect(iphone.osVersion).toBe("17.5");
		expect(iphone.platform).toBe("ios");
		expect(ipad.osName).toBe("iPadOS");
		expect(ipad.osVersion).toBe("17.5");
		expect(ipad.platform).toBe("ios");
	});

	test("maps Windows NT versions", () => {
		const device = parseUserAgent(EDGE_UA);

		expect(device.osName).toBe("Windows");
		expect(device.osVersion).toBe("10/11");
	});

	test("honors explicit app platform overrides", () => {
		const device = parseUserAgent(EDGE_UA, "desktop");

		expect(device.platform).toBe("desktop");
		expect(device.deviceName).toBe("Bittery Desktop on Windows");
	});

	test("keeps device-name formatting parity", () => {
		expect(parseUserAgent(EDGE_UA).deviceName).toBe("Edge on Windows");
		expect(parseUserAgent(IPHONE_UA).deviceName).toBe("Bittery on iOS 17.5");
		expect(getDesktopDeviceInfo("macOS", "15.0").deviceName).toBe(
			"Bittery Desktop on macOS",
		);
		expect(getExtensionDeviceInfo("Chrome", "132.0.0.0").deviceName).toBe(
			"Bittery Extension (Chrome)",
		);
	});

	test("formats device display output", () => {
		expect(
			formatDeviceDisplay({
				deviceName: "MacBook Pro",
				osName: "macOS",
				osVersion: "15.0",
				browserName: "Safari",
				browserVersion: "18.0",
			}),
		).toEqual({
			title: "MacBook Pro",
			subtitle: "macOS 15.0 - Safari 18.0",
		});
	});

	test("formats relative last active timestamps", () => {
		expect(formatLastActive(new Date(Date.now() - 2 * 60 * 60 * 1000))).toBe(
			"2 hours ago",
		);
	});
});
