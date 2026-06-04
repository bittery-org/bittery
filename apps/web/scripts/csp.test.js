import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	collectInlineScriptHashes,
	renderNginxConfig,
	resolveConnectSrc,
} from "./csp.js";

describe("web CSP rendering", () => {
	test("hashes inline bootstrap scripts", () => {
		const hashes = collectInlineScriptHashes([
			"<html><body><script>window.__BOOT__ = 1;</script></body></html>",
		]);

		expect(hashes).toHaveLength(1);
		expect(hashes[0]?.startsWith("'sha256-")).toBe(true);
	});

	test("renders nginx config without unsafe script allowances", () => {
		const template = readFileSync(
			resolve(import.meta.dir, "../nginx.conf"),
			"utf8",
		);
		const rendered = renderNginxConfig(
			template,
			["'sha256-test-hash'"],
			resolveConnectSrc("https://api.bittery.com/rpc"),
		);

		expect(rendered).not.toContain("cloudflare");
		expect(rendered).not.toContain("'unsafe-eval'");
		expect(rendered).not.toContain("ws:");
		expect(rendered).not.toContain("'unsafe-inline' 'unsafe-eval'");
		expect(rendered).toContain("'sha256-test-hash'");
		expect(rendered).toContain("connect-src 'self' https://api.bittery.com;");
		expect(rendered).not.toContain("__CSP_SCRIPT_HASHES__");
		expect(rendered).not.toContain("__CSP_CONNECT_SRC__");
	});

	test("falls back to self when no external API origin is configured", () => {
		expect(resolveConnectSrc("")).toBe("'self'");
		expect(resolveConnectSrc("not a url")).toBe("'self'");
	});
});
