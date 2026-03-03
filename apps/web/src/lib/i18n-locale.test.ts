import { expect, test } from "@playwright/test";
import {
	persistLocaleSelection,
	resolveBrowserLocale,
	resolveLocale,
} from "./i18n-locale";

test.describe("i18n locale helpers", () => {
	test("resolveBrowserLocale picks de for de-DE and en otherwise", () => {
		expect(resolveBrowserLocale("de-DE")).toBe("de");
		expect(resolveBrowserLocale("de-AT")).toBe("de");
		expect(resolveBrowserLocale("en-US")).toBe("en");
		expect(resolveBrowserLocale("fr-FR")).toBe("en");
		expect(resolveBrowserLocale(undefined)).toBe("en");
	});

	test("resolveLocale prefers explicit stored locale", () => {
		expect(
			resolveLocale({
				storedLocale: "de",
				browserLocale: "en-US",
			}),
		).toBe("de");

		expect(
			resolveLocale({
				storedLocale: "en",
				browserLocale: "de-DE",
			}),
		).toBe("en");
	});

	test("persistLocaleSelection stores locale and updates runtime", async () => {
		const values: Record<string, string> = {};
		const runtimeCalls: Array<{ locale: string; reload: boolean | undefined }> =
			[];

		await persistLocaleSelection({
			locale: "de",
			storage: {
				setItem: (key, value) => {
					values[key] = value;
				},
			},
			setRuntimeLocale: (locale, options) => {
				runtimeCalls.push({
					locale,
					reload: options?.reload,
				});
			},
		});

		expect(values["bittery.locale"]).toBe("de");
		expect(runtimeCalls).toEqual([{ locale: "de", reload: false }]);
	});
});
