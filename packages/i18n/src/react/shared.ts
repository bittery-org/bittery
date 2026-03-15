import { createElement, type ReactNode, useMemo } from "react";
import type {
	LocaleEnvironmentAdapter,
	LocaleRuntimeAdapter,
	LocaleStorageAdapter,
} from "../adapters";
import type { CompiledMessages, MessageCatalog } from "../index";
import { createI18nReact } from "./create-i18n-react";

type SharedI18nInput<M extends MessageCatalog> = {
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
};

type SharedI18nApi<M extends MessageCatalog> = ReturnType<
	typeof createI18nReact<M>
>;

type SharedI18nApiInternal = SharedI18nApi<MessageCatalog>;

let sharedI18nApi: SharedI18nApiInternal | null = null;

export function initializeI18nReact<M extends MessageCatalog>(
	input: SharedI18nInput<M>,
) {
	if (!sharedI18nApi) {
		sharedI18nApi = createI18nReact(input) as SharedI18nApiInternal;
	}

	return sharedI18nApi as SharedI18nApi<M>;
}

function getSharedI18nApi<M extends MessageCatalog>() {
	if (!sharedI18nApi) {
		throw new Error("initializeI18nReact must be called before using i18n");
	}

	return sharedI18nApi as SharedI18nApi<M>;
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const Component = useMemo(() => getSharedI18nApi().I18nProvider, []);
	return createElement(Component, null, children);
}

export function useI18n<M extends MessageCatalog = CompiledMessages>() {
	return getSharedI18nApi<M>().useI18n();
}
