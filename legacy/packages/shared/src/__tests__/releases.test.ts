import { describe, expect, test } from "bun:test";
import {
	detectOS,
	GITHUB_REPO,
	getPrimaryDownloadForOS,
	latestDownloadUrl,
	RELEASE_ASSETS,
} from "../releases";

describe("releases", () => {
	test("latestDownloadUrl builds GitHub latest download path", () => {
		expect(latestDownloadUrl(RELEASE_ASSETS.macos)).toBe(
			`https://github.com/${GITHUB_REPO}/releases/latest/download/Bittery.dmg`,
		);
	});

	test("getPrimaryDownloadForOS returns platform-specific assets", () => {
		expect(getPrimaryDownloadForOS("macos")?.filename).toBe(
			RELEASE_ASSETS.macos,
		);
		expect(getPrimaryDownloadForOS("windows")?.filename).toBe(
			RELEASE_ASSETS.windowsSetup,
		);
		expect(getPrimaryDownloadForOS("linux")?.filename).toBe(
			RELEASE_ASSETS.linuxAppImage,
		);
		expect(getPrimaryDownloadForOS("unknown")).toBeNull();
	});

	test("detectOS returns unknown without navigator", () => {
		expect(detectOS()).toBe("unknown");
	});
});
