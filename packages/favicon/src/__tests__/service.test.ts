import { describe, expect, test } from "bun:test";
import { normalizeFaviconDomain } from "../service";

describe("normalizeFaviconDomain", () => {
	test("normalizes hostnames and strips protocol", () => {
		expect(normalizeFaviconDomain("https://Example.COM/login")).toBe(
			"example.com",
		);
	});

	test("returns null for invalid hostnames", () => {
		expect(normalizeFaviconDomain("http://exa mple.com")).toBeNull();
		expect(normalizeFaviconDomain("-example.com")).toBeNull();
		expect(normalizeFaviconDomain("")).toBeNull();
	});
});
