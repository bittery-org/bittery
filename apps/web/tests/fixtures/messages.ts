/**
 * The UI strings a spec has to click, read from the files the app's own
 * messages are compiled from (`pnpm i18n:generate`).
 *
 * Copy is a last resort - prefer a `data-testid`. Where a control has none,
 * going through this reader means a wording change in
 * `packages/i18n/messages/*.json` moves the selector instead of breaking it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Mirrors `supportedLocales` in `packages/i18n/src/index.ts`. */
export type MessageLocale = "en" | "de";

const messagesDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/i18n/messages",
);

const catalogues = new Map<MessageLocale, Record<string, unknown>>();

function catalogue(locale: MessageLocale): Record<string, unknown> {
	const cached = catalogues.get(locale);
	if (cached) {
		return cached;
	}
	const loaded = JSON.parse(
		readFileSync(path.join(messagesDir, `${locale}.json`), "utf8"),
	) as Record<string, unknown>;
	catalogues.set(locale, loaded);
	return loaded;
}

/**
 * The text of one message key in one locale, as rendered by the app.
 *
 * `params` fills the `{name}` placeholders a parameterised message carries, so
 * a spec never hand-assembles the rendered string.
 */
export function uiTextIn(
	locale: MessageLocale,
	key: string,
	params: Record<string, string | number> = {},
): string {
	const value = catalogue(locale)[key];
	if (typeof value !== "string") {
		throw new Error(
			`No ${locale} message for "${key}" in ${messagesDir}/${locale}.json. Check the key, or run \`pnpm i18n:generate\`.`,
		);
	}
	return Object.entries(params).reduce(
		(text, [name, replacement]) =>
			text.split(`{${name}}`).join(String(replacement)),
		value,
	);
}

/** The English text of one message key - the default the app boots with. */
export function uiText(
	key: string,
	params: Record<string, string | number> = {},
): string {
	return uiTextIn("en", key, params);
}
