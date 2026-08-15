import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Paraglide's generated `messages.js` is a barrel over one module per message — 5000-odd
 * of them. Reaching it by relative path serves every one of those as its own request in
 * dev, because only the bare `@bittery/i18n/paraglide/*` specifier resolves to the copy
 * Vite pre-bundles through `optimizeDeps.include`. Ordinary pages merely crawl under
 * that; the browser extension dies, since crxjs proxies every request through the MV3
 * service worker and the flood fails as `net::ERR_FAILED`.
 *
 * `runtime.js` has the same rule for a second reason: loaded both ways it exists twice,
 * and `overwriteGetLocale` then rewrites a copy the app never reads.
 *
 * Type-only imports are exempt — they are erased and reach no bundler.
 */

const SOURCE_ROOT = new URL("../src", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "paraglide" ? [] : sourceFiles(full);
		}
		return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")
			? [full]
			: [];
	});
}

const RELATIVE_PARAGLIDE_IMPORT =
	/^import\s+(?!type\s)[\s\S]*?from\s+"(\.[^"]*paraglide\/[^"]*)"/gm;

describe("the paraglide entry points", () => {
	test.each(
		sourceFiles(SOURCE_ROOT).map((file) => [
			path.relative(SOURCE_ROOT, file),
			file,
		]),
	)(
		"%s reaches them by package subpath, never by relative path",
		(_name, file) => {
			const source = readFileSync(file, "utf8");
			const offenders = [...source.matchAll(RELATIVE_PARAGLIDE_IMPORT)].map(
				(match) => match[1],
			);

			expect(offenders).toEqual([]);
		},
	);
});
