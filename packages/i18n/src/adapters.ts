import type { AppLocale } from "./index";

export interface LocaleRuntimeAdapter {
	getLocale(): AppLocale;
	setLocale(
		locale: AppLocale,
		options?: { reload?: boolean },
	): void | Promise<void>;
}

export interface LocaleStorageAdapter {
	getItem(key: string): string | null | Promise<string | null>;
	setItem(key: string, value: string): void | Promise<void>;
}

export interface LocaleEnvironmentAdapter {
	getBrowserLocale(): string | null | undefined;
	applyLocale?(locale: AppLocale): void;
}
