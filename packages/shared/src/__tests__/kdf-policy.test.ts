import { describe, expect, test } from "bun:test";
import {
	currentKdfProfile,
	isCurrentKdfProfile,
	validateKdfProfileOrThrow,
} from "../kdf-policy";

const profile = (iterations: number) => ({
	schemaVersion: 1 as const,
	algorithm: "pbkdf2-sha256" as const,
	iterations,
});

describe("KDF profile policy", () => {
	test("returns the canonical current profile", () => {
		expect(currentKdfProfile()).toEqual(profile(600_000));
		expect(isCurrentKdfProfile(profile(600_000))).toBe(true);
		expect(isCurrentKdfProfile(profile(1_200_000))).toBe(false);
	});

	test.each([600_000, 1_200_000])("accepts %i iterations", (iterations) => {
		expect(() => validateKdfProfileOrThrow(profile(iterations))).not.toThrow();
	});

	test.each([
		310_000,
		599_999,
		1_200_001,
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid iteration count %s", (iterations) => {
		expect(() => validateKdfProfileOrThrow(profile(iterations))).toThrow();
	});

	test.each([
		"PBKDF2-SHA256",
		"pbkdf2-sha256 ",
		" pbkdf2-sha256",
		"pbkdf2_sha256",
		"sha256",
		"",
	])("rejects noncanonical algorithm %s", (algorithm) => {
		expect(() =>
			validateKdfProfileOrThrow({ ...profile(600_000), algorithm }),
		).toThrow("Unsupported KDF algorithm");
	});

	test("rejects a downgrade before derivation", () => {
		expect(() =>
			validateKdfProfileOrThrow(profile(600_000), profile(1_200_000)),
		).toThrow("KDF iterations downgraded from pinned value");
	});
});
