/// <reference types="bun" />
/**
 * Two QR payloads share one camera: TOTP `otpauth://` (create-item sheet) and
 * `bittery://login?setup=1…` (sign-in). The Android plugin also throws unless
 * `requestPermissions` has already granted the camera.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	buildDeviceSetupLinkUri,
	buildDeviceSetupQrUri,
} from "@bittery/shared/device-setup";

const VALID_URI =
	"otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

const SETUP_QR = buildDeviceSetupQrUri({
	email: "julian@uxcrew.de",
	serverUrl: "https://api.bittery.com",
	secretKey: "A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G",
	teamName: "UX Crew",
});

const SETUP_LINK = buildDeviceSetupLinkUri({
	email: "julian@uxcrew.de",
	serverUrl: "https://api.bittery.com",
});

const requestPermissions = mock(async (): Promise<string> => "granted");
const scan = mock(async () => ({
	content: VALID_URI,
	format: "QR_CODE",
	bounds: null,
}));
const cancel = mock(async () => undefined);

mock.module("@tauri-apps/plugin-barcode-scanner", () => ({
	Format: { QRCode: "QR_CODE" },
	requestPermissions,
	scan,
	cancel,
}));

const clipboardWrites: string[] = [];
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: {
		clipboard: {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		},
	},
});

const {
	CameraPermissionDeniedError,
	InvalidDeviceSetupQrError,
	InvalidTotpSecretError,
	NotAnOtpAuthUriError,
	formatScanError,
	isScanCancelled,
	scanDeviceSetupQr,
	scanTotpSetupToClipboard,
	totpFormPrefillFromScan,
} = await import("./barcode-scanner");

beforeEach(() => {
	requestPermissions.mockReset();
	requestPermissions.mockImplementation(async () => "granted");
	scan.mockReset();
	scan.mockImplementation(async () => ({
		content: VALID_URI,
		format: "QR_CODE",
		bounds: null,
	}));
	clipboardWrites.length = 0;
});

describe("scanTotpSetupToClipboard", () => {
	test("requests camera permission before opening the scanner", async () => {
		const order: string[] = [];
		requestPermissions.mockImplementation(async () => {
			order.push("request");
			return "granted";
		});
		scan.mockImplementation(async () => {
			order.push("scan");
			return { content: VALID_URI, format: "QR_CODE", bounds: null };
		});

		await scanTotpSetupToClipboard();

		expect(order).toEqual(["request", "scan"]);
		expect(scan).toHaveBeenCalledWith({
			windowed: true,
			formats: ["QR_CODE"],
		});
	});

	test("does not open the scanner when camera permission is denied", async () => {
		requestPermissions.mockImplementation(async () => "denied");

		await expect(scanTotpSetupToClipboard()).rejects.toBeInstanceOf(
			CameraPermissionDeniedError,
		);
		expect(scan).not.toHaveBeenCalled();
		expect(clipboardWrites).toEqual([]);
	});

	test("writes a valid otpauth URI to the clipboard after a successful scan", async () => {
		const result = await scanTotpSetupToClipboard();

		expect(result.uri).toBe(VALID_URI);
		expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
		expect(result.issuer).toBe("GitHub");
		expect(result.accountName).toBe("octocat");
		expect(clipboardWrites).toEqual([VALID_URI]);
	});

	test("rejects a scanned code that is not an otpauth URI", async () => {
		scan.mockImplementation(async () => ({
			content: SETUP_QR,
			format: "QR_CODE",
			bounds: null,
		}));

		await expect(scanTotpSetupToClipboard()).rejects.toBeInstanceOf(
			NotAnOtpAuthUriError,
		);
		expect(clipboardWrites).toEqual([]);
	});

	test("rejects an otpauth URI whose secret is not base32", async () => {
		scan.mockImplementation(async () => ({
			content: "otpauth://totp/Broken:user?secret=01890&issuer=Broken",
			format: "QR_CODE",
			bounds: null,
		}));

		await expect(scanTotpSetupToClipboard()).rejects.toBeInstanceOf(
			InvalidTotpSecretError,
		);
		expect(clipboardWrites).toEqual([]);
	});
});

describe("totpFormPrefillFromScan", () => {
	test("fills the authenticator form the way TotpForm's clipboard import does", () => {
		expect(
			totpFormPrefillFromScan({
				uri: VALID_URI,
				secret: "JBSWY3DPEHPK3PXP",
				issuer: "GitHub",
				accountName: "octocat",
			}),
		).toEqual({
			title: "GitHub (octocat)",
			totpSecret: "JBSW Y3DP EHPK 3PXP",
			totpIssuer: "GitHub",
			totpAccountName: "octocat",
			totpAlgorithm: undefined,
			totpDigits: undefined,
			totpPeriod: undefined,
		});
	});
});

describe("scanDeviceSetupQr", () => {
	test("parses a desktop setup QR that includes the Secret Key", async () => {
		scan.mockImplementation(async () => ({
			content: SETUP_QR,
			format: "QR_CODE",
			bounds: null,
		}));

		const result = await scanDeviceSetupQr();

		expect(result.email).toBe("julian@uxcrew.de");
		expect(result.serverUrl).toBe("https://api.bittery.com");
		expect(result.secretKey).toBe("A3-73ASV5-LCMRCU-B7TMM-VMH3K-QC27G");
		expect(result.teamName).toBe("UX Crew");
	});

	test("accepts a setup link QR that has no Secret Key", async () => {
		scan.mockImplementation(async () => ({
			content: SETUP_LINK,
			format: "QR_CODE",
			bounds: null,
		}));

		const result = await scanDeviceSetupQr();

		expect(result.email).toBe("julian@uxcrew.de");
		expect(result.secretKey).toBeUndefined();
	});

	test("rejects a TOTP QR on the device-setup scanner", async () => {
		await expect(scanDeviceSetupQr()).rejects.toBeInstanceOf(
			InvalidDeviceSetupQrError,
		);
	});

	test("does not open the scanner when camera permission is denied", async () => {
		requestPermissions.mockImplementation(async () => "denied");

		await expect(scanDeviceSetupQr()).rejects.toBeInstanceOf(
			CameraPermissionDeniedError,
		);
		expect(scan).not.toHaveBeenCalled();
	});
});

describe("scan error helpers", () => {
	test("treats the plugin's cancelled reject as a silent cancel", () => {
		expect(isScanCancelled("cancelled")).toBe(true);
		expect(isScanCancelled({ message: "cancelled" })).toBe(true);
		expect(isScanCancelled(new Error("cancelled"))).toBe(true);
		expect(isScanCancelled({ message: "No permission" })).toBe(false);
	});

	test("stringifies a Tauri invoke object instead of [object Object]", () => {
		expect(formatScanError({ message: "No permission to use camera" })).toBe(
			"No permission to use camera",
		);
	});
});
