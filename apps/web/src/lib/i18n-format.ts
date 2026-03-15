import { createI18nFormatters } from "@bittery/i18n/format";
import { getLocale } from "@bittery/i18n/paraglide/runtime";

const formatters = createI18nFormatters(getLocale);

export const { formatDate, formatDateTime, formatNumber, formatCurrency } =
	formatters;
