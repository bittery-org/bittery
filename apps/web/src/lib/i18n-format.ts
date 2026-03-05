import { createI18nFormatters } from "@bittery/i18n/format";
import { getLocale } from "@/paraglide/runtime";

const formatters = createI18nFormatters(getLocale);

export const { formatDate, formatDateTime, formatNumber, formatCurrency } =
	formatters;
