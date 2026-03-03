import { describe, expect, test } from "bun:test";
import type { AppLocale } from "./index";
import { initializeLocale, persistLocaleSelection } from "./locale-persistence";

describe("locale persistence", () => {
	test("persistLocaleSelection stores locale and updates runtime without reload", async () => {
		const values: Record<string, string> = {};
		const runtimeCalls: Array<{
			locale: AppLocale;
			reload: boolean | undefined;
		}> = [];

		await persistLocaleSelection({
			locale: "de",
			runtime: {
				getLocale: () => "en",
				setLocale: (locale, options) => {
					runtimeCalls.push({ locale, reload: options?.reload });
				},
			},
			storage: {
				getItem: () => null,
				setItem: (key, value) => {
					values[key] = value;
				},
			},
		});

		expect(values["bittery.locale"]).toBe("de");
		expect(runtimeCalls).toEqual([{ locale: "de", reload: false }]);
	});

	test("persistLocaleSelection applies runtime locale before async storage settles", async () => {
		const callOrder: string[] = [];

		await persistLocaleSelection({
			locale: "de",
			runtime: {
				getLocale: () => "en",
				setLocale: () => {
					callOrder.push("runtime");
				},
			},
			storage: {
				getItem: () => null,
				setItem: async () => {
					callOrder.push("storage-start");
					await Promise.resolve();
					callOrder.push("storage-end");
				},
			},
		});

		expect(callOrder).toEqual(["runtime", "storage-start", "storage-end"]);
	});

	test("initializeLocale uses stored locale when present", async () => {
		const runtimeCalls: AppLocale[] = [];
		const locale = await initializeLocale({
			runtime: {
				getLocale: () => "en",
				setLocale: (value) => {
					runtimeCalls.push(value);
				},
			},
			storage: {
				getItem: async () => "de",
				setItem: () => undefined,
			},
			detectLocale: async () => "en-US",
		});

		expect(locale).toBe("de");
		expect(runtimeCalls).toEqual(["de"]);
	});

	test("initializeLocale falls back to detected locale when no stored locale", async () => {
		const locale = await initializeLocale({
			runtime: {
				getLocale: () => "en",
				setLocale: () => undefined,
			},
			storage: {
				getItem: () => null,
				setItem: () => undefined,
			},
			detectLocale: () => "de-DE",
		});

		expect(locale).toBe("de");
	});

	test("initializeLocale falls back to default locale when nothing resolves", async () => {
		const locale = await initializeLocale({
			runtime: {
				getLocale: () => "en",
				setLocale: () => undefined,
			},
			storage: {
				getItem: () => null,
				setItem: () => undefined,
			},
			detectLocale: () => undefined,
		});

		expect(locale).toBe("en");
	});
});
