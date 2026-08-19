/**
 * The phone does not read `src-tauri/icons/` directly. `tauri android init` / `ios init`
 * copy a snapshot into `gen/`, and that snapshot is what the launcher shows. Those
 * generated files stayed on the default Tauri mark after the source icons were swapped
 * for Bittery — this test is the tripwire so that does not happen again.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceIcons = join(mobileRoot, "src-tauri/icons");
const androidRes = join(mobileRoot, "src-tauri/gen/android/app/src/main/res");
const iosAppIcon = join(
	mobileRoot,
	"src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset",
);

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("Android launcher icons", () => {
	const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"] as const;
	const names = [
		"ic_launcher.png",
		"ic_launcher_foreground.png",
		"ic_launcher_round.png",
	] as const;

	for (const density of densities) {
		for (const name of names) {
			test(`mipmap-${density}/${name} matches the Tauri icon source`, () => {
				const source = join(sourceIcons, "android", `mipmap-${density}`, name);
				const generated = join(androidRes, `mipmap-${density}`, name);
				expect(existsSync(source)).toBe(true);
				expect(existsSync(generated)).toBe(true);
				expect(sha256(generated)).toBe(sha256(source));
			});
		}
	}

	test("adaptive icon XML is present and points at the Bittery foreground", () => {
		const adaptive = readFileSync(
			join(androidRes, "mipmap-anydpi-v26/ic_launcher.xml"),
			"utf8",
		);
		expect(adaptive).toContain("@mipmap/ic_launcher_foreground");
		expect(adaptive).toContain("@color/ic_launcher_background");
	});

	test("default Android Studio launcher drawables are gone", () => {
		expect(
			existsSync(join(androidRes, "drawable-v24/ic_launcher_foreground.xml")),
		).toBe(false);
		expect(
			existsSync(join(androidRes, "drawable/ic_launcher_background.xml")),
		).toBe(false);
	});
});

describe("iOS app icons", () => {
	const sourceDir = join(sourceIcons, "ios");
	const pngs = readdirSync(sourceDir).filter((name) => name.endsWith(".png"));

	test("the source set is not empty", () => {
		expect(pngs.length).toBeGreaterThan(0);
	});

	for (const name of pngs) {
		test(`${name} matches the Tauri icon source`, () => {
			const source = join(sourceDir, name);
			const generated = join(iosAppIcon, name);
			expect(existsSync(generated)).toBe(true);
			expect(sha256(generated)).toBe(sha256(source));
		});
	}
});

describe("WebView favicon", () => {
	test("index.html uses the Bittery favicon, not the Vite placeholder", () => {
		const html = readFileSync(join(mobileRoot, "index.html"), "utf8");
		expect(html).toContain('href="/favicon.png"');
		expect(html).not.toContain("vite.svg");
	});
});
