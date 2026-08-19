import {
	createContext,
	createElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	LocaleEnvironmentAdapter,
	LocaleRuntimeAdapter,
	LocaleStorageAdapter,
} from "../adapters";
import { type AppLocale, defaultLocale, type MessageCatalog } from "../index";
import {
	initializeLocale,
	persistLocaleSelection,
} from "../locale-persistence";

interface I18nContextValue<M> {
	locale: AppLocale;
	setLocale: (locale: AppLocale) => void;
	m: M;
}

function safeGetLocale(runtime: LocaleRuntimeAdapter): AppLocale {
	try {
		return runtime.getLocale();
	} catch {
		return defaultLocale;
	}
}

export function createI18nReact<M extends MessageCatalog>(input: {
	messages: M;
	runtime: LocaleRuntimeAdapter;
	storage?: LocaleStorageAdapter;
	detectLocale?: () =>
		| string
		| null
		| undefined
		| Promise<string | null | undefined>;
	sideEffects?: Pick<LocaleEnvironmentAdapter, "applyLocale">;
	storageKey?: string;
}) {
	const { messages, runtime, storage, detectLocale, sideEffects, storageKey } =
		input;

	const I18nContext = createContext<I18nContextValue<M> | null>(null);

	function I18nProvider({ children }: { children: ReactNode }) {
		const applyLocale = useCallback((nextLocale: AppLocale) => {
			sideEffects?.applyLocale?.(nextLocale);
		}, []);
		const [locale, setLocaleState] = useState<AppLocale>(() => {
			const initialLocale = safeGetLocale(runtime);
			applyLocale(initialLocale);
			return initialLocale;
		});
		const hasManualLocaleSelectionRef = useRef(false);

		useEffect(() => {
			let isMounted = true;

			const initialize = async () => {
				const initializedLocale = await initializeLocale({
					runtime,
					storage,
					detectLocale,
					storageKey,
				});

				if (!isMounted) {
					return;
				}

				// Avoid overwriting a locale chosen by the user while init was in-flight.
				if (hasManualLocaleSelectionRef.current) {
					return;
				}

				applyLocale(initializedLocale);
				setLocaleState(initializedLocale);
			};

			void initialize();

			return () => {
				isMounted = false;
			};
		}, [applyLocale]);

		const setLocale = useCallback(
			(nextLocale: AppLocale) => {
				hasManualLocaleSelectionRef.current = true;
				applyLocale(nextLocale);
				setLocaleState(nextLocale);
				void persistLocaleSelection({
					locale: nextLocale,
					runtime,
					storage,
					storageKey,
				});
			},
			[applyLocale],
		);

		const value = useMemo(
			() => ({
				locale,
				setLocale,
				m: messages,
			}),
			[locale, setLocale],
		);

		return createElement(I18nContext.Provider, { value }, children);
	}

	function useI18n(): I18nContextValue<M> {
		const context = useContext(I18nContext);
		if (!context) {
			throw new Error("useI18n must be used within an I18nProvider");
		}
		return context;
	}

	return {
		I18nProvider,
		useI18n,
	};
}
