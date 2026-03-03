import {
	type AppLocale,
	type LocaleRuntimeAdapter,
	type LocaleStorageAdapter,
	defaultLocale,
	isAppLocale,
} from "@bittery/i18n";
import { createI18nReact } from "@bittery/i18n/react";
import { m } from "@/paraglide/messages";
import {
	getLocale as getRuntimeLocale,
	overwriteGetLocale,
	overwriteSetLocale,
	setLocale as setRuntimeLocale,
} from "@/paraglide/runtime";

let currentLocale: AppLocale = defaultLocale;

try {
	const runtimeLocale = getRuntimeLocale();
	if (isAppLocale(runtimeLocale)) {
		currentLocale = runtimeLocale;
	}
} catch {
	currentLocale = defaultLocale;
}

overwriteGetLocale(() => currentLocale);
overwriteSetLocale((nextLocale) => {
	currentLocale = isAppLocale(nextLocale) ? nextLocale : defaultLocale;
});

const runtimeAdapter: LocaleRuntimeAdapter = {
	getLocale: () => currentLocale,
	setLocale: (locale, options) => setRuntimeLocale(locale, options),
};

const storageAdapter: LocaleStorageAdapter | undefined =
	typeof window === "undefined"
		? undefined
		: {
				getItem: (key) => window.localStorage.getItem(key),
				setItem: (key, value) => {
					window.localStorage.setItem(key, value);
				},
			};

const { I18nProvider, useI18n } = createI18nReact({
	messages: m,
	runtime: runtimeAdapter,
	storage: storageAdapter,
	detectLocale: () =>
		typeof window === "undefined" ? undefined : window.navigator.language,
	sideEffects: {
		applyLocale: (locale) => {
			if (typeof document !== "undefined") {
				document.documentElement.lang = locale;
			}
		},
	},
});

export { I18nProvider, useI18n };
