import { describe, expect, test } from "bun:test";
import { resolveBrowserLocale, resolveLocale } from "./locale-resolution";

describe("locale resolution", () => {
	test("resolveBrowserLocale handles de variants and default fallback", () => {
		expect(resolveBrowserLocale("de-DE")).toBe("de");
		expect(resolveBrowserLocale("de-AT")).toBe("de");
		expect(resolveBrowserLocale(undefined)).toBe("en");
		expect(resolveBrowserLocale("fr-FR")).toBe("en");
	});

	test("resolveLocale prefers valid stored locale", () => {
		expect(
			resolveLocale({
				storedLocale: "de",
				browserLocale: "en-US",
			}),
		).toBe("de");
	});

	test("resolveLocale falls back to browser locale when stored locale is invalid", () => {
		expect(
			resolveLocale({
				storedLocale: "es",
				browserLocale: "de-DE",
			}),
		).toBe("de");
	});
});
