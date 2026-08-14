/**
 * Formatters already bound to the Paraglide runtime locale.
 *
 * `createI18nFormatters` takes a locale getter so a host can supply its own;
 * every DOM host supplies the same one, and `apps/web` and `apps/desktop` had
 * byte-identical files doing it. Hosts that resolve the locale differently
 * (`apps/mobile`) still call `createI18nFormatters` directly.
 */

import { createI18nFormatters } from "./formatters";
import { getLocale } from "./paraglide/runtime.js";

export const { formatDate, formatDateTime, formatNumber, formatCurrency } =
	createI18nFormatters(getLocale);
