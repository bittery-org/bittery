import type { AppLocale } from "./index";

type DateInput = Date | string | number;

function normalizeDate(value: DateInput): Date {
	return value instanceof Date ? value : new Date(value);
}

export function createI18nFormatters(getLocale: () => AppLocale) {
	return {
		formatDate(value: DateInput, options?: Intl.DateTimeFormatOptions): string {
			return new Intl.DateTimeFormat(getLocale(), options).format(
				normalizeDate(value),
			);
		},
		formatDateTime(
			value: DateInput,
			options?: Intl.DateTimeFormatOptions,
		): string {
			return new Intl.DateTimeFormat(getLocale(), options).format(
				normalizeDate(value),
			);
		},
		formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
			return new Intl.NumberFormat(getLocale(), options).format(value);
		},
		formatCurrency(
			value: number,
			currency: string,
			options?: Intl.NumberFormatOptions,
		): string {
			return new Intl.NumberFormat(getLocale(), {
				style: "currency",
				currency,
				...options,
			}).format(value);
		},
	};
}
