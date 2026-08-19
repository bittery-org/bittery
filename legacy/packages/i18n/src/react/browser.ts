/**
 * The browser-side i18n wiring, in one place.
 *
 * This was byte-identical in `apps/web`, `apps/desktop` and `apps/extension`.
 * None of it is app-specific: it is what any DOM host has to do to bridge
 * Paraglide's module-level locale to the React runtime.
 *
 * Two details are load-bearing and easy to lose in a rewrite:
 *
 *   - `getLocale()` is called at module scope and can throw before Paraglide has
 *     a locale, so the read is wrapped and falls back to {@link defaultLocale}.
 *   - Every `window`/`document` access is guarded. `apps/web` renders on the
 *     server (TanStack Start), where this module is evaluated with neither.
 *
 * `apps/mobile` deliberately does not use this: it persists through AsyncStorage,
 * detects the locale through `Intl`, and has no `document` to set `lang` on. Its
 * provider calls {@link createI18nReact} directly, which is the seam this and it
 * share.
 */

import { m } from "@bittery/i18n/paraglide/messages";
import {
	getLocale as getRuntimeLocale,
	overwriteGetLocale,
	overwriteSetLocale,
	setLocale as setRuntimeLocale,
} from "@bittery/i18n/paraglide/runtime";
import type { LocaleRuntimeAdapter, LocaleStorageAdapter } from "../adapters";
import { type AppLocale, defaultLocale, isAppLocale } from "../index";
import { I18nProvider, initializeI18nReact, useI18n } from "./shared";

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

initializeI18nReact({
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
