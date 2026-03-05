export const supportedLocales = ["en", "de"] as const;

export type AppLocale = (typeof supportedLocales)[number];

export const defaultLocale: AppLocale = "en";

export const localeStorageKey = "bittery.locale";

export function isAppLocale(value: unknown): value is AppLocale {
	return (
		typeof value === "string" && supportedLocales.includes(value as AppLocale)
	);
}

export type {
	LocaleEnvironmentAdapter,
	LocaleRuntimeAdapter,
	LocaleStorageAdapter,
} from "./adapters";
export { createI18nFormatters } from "./formatters";
export { initializeLocale, persistLocaleSelection } from "./locale-persistence";
export { resolveBrowserLocale, resolveLocale } from "./locale-resolution";
export { createI18nReact } from "./react/create-i18n-react";
