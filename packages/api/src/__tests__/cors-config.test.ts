import { describe, expect, test } from "bun:test";
import { parseCorsOrigins } from "../config/cors";

describe("parseCorsOrigins", () => {
	test("accepts localhost http origins and concrete https origins", () => {
		expect(
			parseCorsOrigins(
				"http://localhost:3000,http://127.0.0.1:3001,http://[::1]:3002,https://vault.example.com",
			),
		).toEqual([
			"http://localhost:3000",
			"http://127.0.0.1:3001",
			"http://[::1]:3002",
			"https://vault.example.com",
		]);
	});

	test("returns an empty list when unset", () => {
		expect(parseCorsOrigins("")).toEqual([]);
		expect(parseCorsOrigins(undefined)).toEqual([]);
	});

	test("rejects wildcard origins", () => {
		expect(() => parseCorsOrigins("*")).toThrow(
			"CORS_ORIGIN must not contain '*'",
		);
	});

	test("rejects non-localhost http origins", () => {
		expect(() => parseCorsOrigins("http://vault.example.com")).toThrow(
			"https outside localhost development",
		);
	});

	test("rejects origins with paths or duplicates", () => {
		expect(() => parseCorsOrigins("https://vault.example.com/app")).toThrow(
			"bare origin",
		);
		expect(() =>
			parseCorsOrigins(
				"https://vault.example.com,https://vault.example.com/",
			),
		).toThrow("duplicate origin");
	});
});
