import {
	type AppLocale,
	defaultLocale,
	isAppLocale,
	type LocaleRuntimeAdapter,
	type LocaleStorageAdapter,
} from "@bittery/i18n";
import { createI18nReact } from "@bittery/i18n/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { m } from "@bittery/i18n/paraglide/messages";
import {
	getLocale as getRuntimeLocale,
	overwriteGetLocale,
	overwriteSetLocale,
	setLocale as setRuntimeLocale,
} from "@bittery/i18n/paraglide/runtime";

function detectDeviceLocale(): string | undefined {
	try {
		const locale = Intl.DateTimeFormat().resolvedOptions().locale;
		if (locale) {
			return locale;
		}
	} catch {
		// Ignore Intl lookup failures and fall back to navigator below.
	}

	if (typeof navigator !== "undefined") {
		return navigator.language;
	}

	return undefined;
}

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

const storageAdapter: LocaleStorageAdapter = {
	getItem: (key) => AsyncStorage.getItem(key),
	setItem: (key, value) => AsyncStorage.setItem(key, value),
};

const { I18nProvider, useI18n } = createI18nReact({
	messages: m,
	runtime: runtimeAdapter,
	storage: storageAdapter,
	detectLocale: detectDeviceLocale,
});

export { I18nProvider, useI18n };
