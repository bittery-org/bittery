import {
	type AppLocale,
	persistLocaleSelection as persistLocaleSelectionCore,
	localeStorageKey,
} from "@bittery/i18n";
export { resolveBrowserLocale, resolveLocale } from "@bittery/i18n";

export async function persistLocaleSelection(input: {
	locale: AppLocale;
	setRuntimeLocale: (
		locale: AppLocale,
		options?: { reload?: boolean },
	) => void | Promise<void>;
	storage?: Pick<Storage, "setItem">;
	storageKey?: string;
}): Promise<void> {
	const {
		locale,
		setRuntimeLocale,
		storage,
		storageKey = localeStorageKey,
	} = input;

	await persistLocaleSelectionCore({
		locale,
		runtime: {
			getLocale: () => locale,
			setLocale: setRuntimeLocale,
		},
		storage: storage
			? {
					getItem: () => null,
					setItem: storage.setItem.bind(storage),
				}
			: undefined,
		storageKey,
	});
}
