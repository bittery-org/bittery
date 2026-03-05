import { type AppLocale, defaultLocale, isAppLocale } from "./index";

export function resolveBrowserLocale(
	browserLocale: string | null | undefined,
): AppLocale {
	return browserLocale?.toLowerCase().startsWith("de") ? "de" : defaultLocale;
}

export function resolveLocale(input: {
	storedLocale: string | null | undefined;
	browserLocale: string | null | undefined;
}): AppLocale {
	if (isAppLocale(input.storedLocale)) {
		return input.storedLocale;
	}

	return resolveBrowserLocale(input.browserLocale);
}
