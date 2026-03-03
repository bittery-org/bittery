import {
	defaultLocale,
	isAppLocale,
	localeStorageKey,
	type AppLocale,
} from "@bittery/i18n";

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

export async function persistLocaleSelection(input: {
	locale: AppLocale;
	setRuntimeLocale: (
		locale: AppLocale,
		options?: { reload?: boolean },
	) => void | Promise<void>;
	storage?: Pick<Storage, "setItem">;
	storageKey?: string;
}): Promise<void> {
	const { locale, setRuntimeLocale, storage, storageKey = localeStorageKey } =
		input;
	storage?.setItem(storageKey, locale);
	await setRuntimeLocale(locale, { reload: false });
}
