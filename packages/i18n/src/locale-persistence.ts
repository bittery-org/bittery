import {
	defaultLocale,
	localeStorageKey,
	type AppLocale,
} from "./index";
import { resolveLocale } from "./locale-resolution";
import type { LocaleRuntimeAdapter, LocaleStorageAdapter } from "./adapters";

export async function persistLocaleSelection(input: {
	locale: AppLocale;
	runtime: LocaleRuntimeAdapter;
	storage?: LocaleStorageAdapter;
	storageKey?: string;
}): Promise<void> {
	const {
		locale,
		runtime,
		storage,
		storageKey = localeStorageKey,
	} = input;

	// Apply runtime locale first so UI renders with the selected locale immediately.
	// Storage persistence can resolve asynchronously afterward.
	const runtimeResult = runtime.setLocale(locale, { reload: false });

	if (storage) {
		await storage.setItem(storageKey, locale);
	}

	await runtimeResult;
}

export async function initializeLocale(input: {
	runtime: LocaleRuntimeAdapter;
	storage?: LocaleStorageAdapter;
	detectLocale?: () =>
		| string
		| null
		| undefined
		| Promise<string | null | undefined>;
	storageKey?: string;
}): Promise<AppLocale> {
	const {
		runtime,
		storage,
		detectLocale,
		storageKey = localeStorageKey,
	} = input;

	const storedLocale = storage ? await storage.getItem(storageKey) : null;
	const browserLocale = detectLocale ? await detectLocale() : null;

	const resolvedLocale = resolveLocale({
		storedLocale,
		browserLocale,
	});

	await persistLocaleSelection({
		locale: resolvedLocale ?? defaultLocale,
		runtime,
		storage,
		storageKey,
	});

	return resolvedLocale;
}
