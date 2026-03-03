export const supportedLocales = ["en", "de"] as const;

export type AppLocale = (typeof supportedLocales)[number];

export const defaultLocale: AppLocale = "en";

export const localeStorageKey = "bittery.locale";

export function isAppLocale(value: unknown): value is AppLocale {
	return (
		typeof value === "string" && supportedLocales.includes(value as AppLocale)
	);
}
