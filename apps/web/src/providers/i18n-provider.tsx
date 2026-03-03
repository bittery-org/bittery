import { type AppLocale, defaultLocale, localeStorageKey } from "@bittery/i18n";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { persistLocaleSelection, resolveLocale } from "@/lib/i18n-locale";
import { m } from "@/paraglide/messages";
import { setLocale as setRuntimeLocale } from "@/paraglide/runtime";

interface I18nContextValue {
	locale: AppLocale;
	setLocale: (locale: AppLocale) => void;
	m: typeof m;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function initializeClientLocale(): AppLocale {
	if (typeof window === "undefined") {
		return defaultLocale;
	}

	const locale = resolveLocale({
		storedLocale: window.localStorage.getItem(localeStorageKey),
		browserLocale: window.navigator.language,
	});

	void persistLocaleSelection({
		locale,
		setRuntimeLocale,
		storage: window.localStorage,
	});

	return locale;
}

const initialClientLocale = initializeClientLocale();

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<AppLocale>(() => {
		if (typeof window === "undefined") {
			return defaultLocale;
		}
		return initialClientLocale;
	});

	const setLocale = useCallback((nextLocale: AppLocale) => {
		if (typeof window === "undefined") {
			setLocaleState(nextLocale);
			return;
		}

		void persistLocaleSelection({
			locale: nextLocale,
			setRuntimeLocale,
			storage: window.localStorage,
		});
		setLocaleState(nextLocale);
	}, []);

	useEffect(() => {
		if (typeof document !== "undefined") {
			document.documentElement.lang = locale;
		}
	}, [locale]);

	const value = useMemo(
		() => ({
			locale,
			setLocale,
			m,
		}),
		[locale, setLocale],
	);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
	const context = useContext(I18nContext);
	if (!context) {
		throw new Error("useI18n must be used within an I18nProvider");
	}
	return context;
}
