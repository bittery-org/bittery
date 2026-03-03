import { getLocale } from "@/paraglide/runtime";

type DateInput = Date | string | number;

function normalizeDate(value: DateInput): Date {
	return value instanceof Date ? value : new Date(value);
}

export function formatDate(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
): string {
	return new Intl.DateTimeFormat(getLocale(), options).format(
		normalizeDate(value),
	);
}

export function formatDateTime(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
): string {
	return new Intl.DateTimeFormat(getLocale(), options).format(
		normalizeDate(value),
	);
}

export function formatNumber(
	value: number,
	options?: Intl.NumberFormatOptions,
): string {
	return new Intl.NumberFormat(getLocale(), options).format(value);
}

export function formatCurrency(
	value: number,
	currency: string,
	options?: Intl.NumberFormatOptions,
): string {
	return new Intl.NumberFormat(getLocale(), {
		style: "currency",
		currency,
		...options,
	}).format(value);
}
