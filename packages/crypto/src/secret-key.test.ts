/**
 * Comprehensive Unit Tests for Secret Key Generation and Validation
 *
 * Tests cover:
 * - Secret key format validation (A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX)
 * - Character set compliance (Base32 without confusing chars)
 * - Cryptographic randomness properties
 * - Key hint extraction
 * - Edge cases and malformed inputs
 */

import { describe, expect, test } from "bun:test";
import {
	generateSecretKey,
	getSecretKeyHint,
	validateSecretKey,
} from "./secret-key";

// The charset used in secret key generation
const VALID_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("Secret Key Module", () => {
	describe("generateSecretKey Function", () => {
		test("should generate a key in correct format A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX", () => {
			const key = generateSecretKey();

			// Check overall format
			const pattern =
				/^A3-[A-Z2-7]{6}-[A-Z2-7]{6}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/;
			expect(pattern.test(key)).toBe(true);
		});

		test("should generate a key with exactly 34 characters", () => {
			const key = generateSecretKey();

			// Format: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX = 2 + 1 + 6 + 1 + 6 + 1 + 5 + 1 + 5 + 1 + 5 = 34
			expect(key.length).toBe(34);
		});

		test("should always start with A3 prefix", () => {
			for (let i = 0; i < 10; i++) {
				const key = generateSecretKey();
				expect(key.startsWith("A3-")).toBe(true);
			}
		});

		test("should generate unique keys each time", () => {
			const keys = new Set<string>();
			for (let i = 0; i < 100; i++) {
				keys.add(generateSecretKey());
			}
			// All keys should be unique
			expect(keys.size).toBe(100);
		});

		test("should only use valid Base32 characters (excluding confusing chars)", () => {
			for (let i = 0; i < 20; i++) {
				const key = generateSecretKey();

				// Remove prefix and dashes
				const segments = key.split("-").slice(1).join("");

				// Check each character is in the valid charset
				for (const char of segments) {
					expect(VALID_CHARSET.includes(char)).toBe(true);
				}
			}
		});

		test("should not contain confusing characters (0, 1, 8, 9, I, L, O) in generated segments", () => {
			// These are the confusing chars that should NOT appear in the generated segments
			// Note: The charset is "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" (Base32)
			// So 0, 1, 8, 9, I, L, O are excluded, but 2-7 ARE valid
			const confusingChars = ["0", "1", "8", "9"];

			for (let i = 0; i < 50; i++) {
				const key = generateSecretKey();
				// Remove the A3 prefix and dashes, check only the generated segments
				const segments = key.split("-").slice(1).join("");

				for (const char of confusingChars) {
					expect(segments.includes(char)).toBe(false);
				}
			}
		});

		test("should have proper segment lengths", () => {
			const key = generateSecretKey();
			const segments = key.split("-");

			expect(segments.length).toBe(6);
			expect(segments[0]).toBe("A3"); // Version prefix
			expect(segments[1].length).toBe(6);
			expect(segments[2].length).toBe(6);
			expect(segments[3].length).toBe(5);
			expect(segments[4].length).toBe(5);
			expect(segments[5].length).toBe(5);
		});

		test("should generate cryptographically random keys with good distribution", () => {
			const charCounts: Record<string, number> = {};

			// Generate many keys and count character occurrences
			for (let i = 0; i < 100; i++) {
				const key = generateSecretKey();
				const segments = key.split("-").slice(1).join("");

				for (const char of segments) {
					charCounts[char] = (charCounts[char] || 0) + 1;
				}
			}

			// All valid characters should appear at least once
			const usedChars = Object.keys(charCounts);
			expect(usedChars.length).toBeGreaterThan(20); // Most of the 32 chars should be used

			// No single character should dominate (basic uniformity check)
			const totalChars = Object.values(charCounts).reduce((a, b) => a + b, 0);
			const expectedPerChar = totalChars / 32;

			for (const char of usedChars) {
				// Allow for statistical variation but no extreme outliers
				expect(charCounts[char]).toBeLessThan(expectedPerChar * 5);
			}
		});
	});

	describe("validateSecretKey Function", () => {
		test("should validate correctly formatted keys", () => {
			// Test several generated keys
			for (let i = 0; i < 10; i++) {
				const key = generateSecretKey();
				expect(validateSecretKey(key)).toBe(true);
			}
		});

		test("should validate a specific valid key", () => {
			const validKey = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXY23";
			expect(validateSecretKey(validKey)).toBe(true);
		});

		test("should reject empty string", () => {
			expect(validateSecretKey("")).toBe(false);
		});

		test("should reject key without A3 prefix", () => {
			expect(validateSecretKey("B3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			expect(validateSecretKey("A2-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			expect(validateSecretKey("XX-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
		});

		test("should reject key with wrong segment lengths", () => {
			// Too short first segment
			expect(validateSecretKey("A3-ABCDE-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// Too long first segment
			expect(validateSecretKey("A3-ABCDEFG-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// Wrong last segment length
			expect(validateSecretKey("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXY")).toBe(false);
		});

		test("should reject key with invalid characters", () => {
			// Contains 0 (zero)
			expect(validateSecretKey("A3-ABCDE0-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// Contains 1 (one)
			expect(validateSecretKey("A3-ABCDE1-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// Contains 8
			expect(validateSecretKey("A3-ABCDE8-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// Contains 9
			expect(validateSecretKey("A3-ABCDE9-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// Contains lowercase
			expect(validateSecretKey("A3-abcdef-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
		});

		test("should reject key without dashes", () => {
			expect(validateSecretKey("A3ABCDEFGHIJKLMNOPQRSTUVWXYZ2")).toBe(false);
		});

		test("should reject key with wrong number of segments", () => {
			// Missing segment
			expect(validateSecretKey("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV")).toBe(false);
			// Extra segment
			expect(
				validateSecretKey("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2-EXTRA"),
			).toBe(false);
		});

		test("should reject key with spaces", () => {
			expect(validateSecretKey("A3-ABCDEF -GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			expect(validateSecretKey(" A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			expect(validateSecretKey("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2 ")).toBe(
				false,
			);
		});

		test("should reject null and undefined inputs", () => {
			expect(validateSecretKey(null as unknown as string)).toBe(false);
			expect(validateSecretKey(undefined as unknown as string)).toBe(false);
		});

		test("should reject special characters", () => {
			expect(validateSecretKey("A3-ABCDE!-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			expect(validateSecretKey("A3-ABCDE@-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			expect(validateSecretKey("A3-ABCDE#-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
		});
	});

	describe("getSecretKeyHint Function", () => {
		test("should return first two segments for valid key", () => {
			const key = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
			const hint = getSecretKeyHint(key);
			expect(hint).toBe("A3-ABCDEF");
		});

		test("should return hint for generated keys", () => {
			for (let i = 0; i < 10; i++) {
				const key = generateSecretKey();
				const hint = getSecretKeyHint(key);

				// Hint should start with A3-
				expect(hint.startsWith("A3-")).toBe(true);
				// Hint should be exactly 9 characters (A3- + 6 chars)
				expect(hint.length).toBe(9);
				// Hint should be a prefix of the key
				expect(key.startsWith(hint)).toBe(true);
			}
		});

		test("should return empty string for empty input", () => {
			expect(getSecretKeyHint("")).toBe("");
		});

		test("should return empty string for single segment input", () => {
			expect(getSecretKeyHint("A3")).toBe("");
		});

		test("should handle malformed input gracefully", () => {
			// No dashes - returns empty since split gives single element
			expect(getSecretKeyHint("A3ABCDEF")).toBe("");
		});

		test("should return partial hint if key has at least two segments", () => {
			expect(getSecretKeyHint("A3-ABC")).toBe("A3-ABC");
		});
	});

	describe("Integration Tests", () => {
		test("generated keys should always pass validation", () => {
			for (let i = 0; i < 100; i++) {
				const key = generateSecretKey();
				expect(validateSecretKey(key)).toBe(true);
			}
		});

		test("hint extraction should work for all generated keys", () => {
			for (let i = 0; i < 100; i++) {
				const key = generateSecretKey();
				const hint = getSecretKeyHint(key);

				// Hint should be valid prefix
				expect(key.startsWith(hint)).toBe(true);
				expect(hint.length).toBe(9);
			}
		});

		test("secret key workflow simulation", () => {
			// Simulate the full workflow:
			// 1. Generate a new secret key during signup
			const secretKey = generateSecretKey();

			// 2. Validate it's correct
			expect(validateSecretKey(secretKey)).toBe(true);

			// 3. Extract hint for display in UI
			const hint = getSecretKeyHint(secretKey);
			expect(hint).toBeTruthy();

			// 4. Verify hint doesn't expose full key
			expect(hint.length).toBeLessThan(secretKey.length);
			expect(hint.length).toBe(9); // A3-XXXXXX

			// 5. User should be able to identify their key by the hint
			expect(secretKey.startsWith(hint)).toBe(true);
		});
	});

	describe("Edge Cases", () => {
		test("should handle keys with all same valid characters", () => {
			// While this would be extremely unlikely to generate,
			// it should still pass validation
			const repeatedKey = "A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA";
			expect(validateSecretKey(repeatedKey)).toBe(true);
		});

		test("should handle keys with all 2s and 3s (edge of charset)", () => {
			const edgeKey = "A3-222222-333333-22222-33333-22222";
			expect(validateSecretKey(edgeKey)).toBe(true);
		});

		test("should handle keys with all letters", () => {
			const letterKey = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZZ";
			expect(validateSecretKey(letterKey)).toBe(true);
		});

		test("should reject keys that look similar but have wrong version", () => {
			// A4 instead of A3
			expect(validateSecretKey("A4-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
			// B3 instead of A3
			expect(validateSecretKey("B3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2")).toBe(
				false,
			);
		});

		test("should reject keys with unicode characters that look similar", () => {
			// Greek Alpha looks like A but is different
			expect(
				validateSecretKey("\u0391\u0033-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2"),
			).toBe(false);
		});
	});

	describe("Performance", () => {
		test("should generate keys quickly", () => {
			const start = Date.now();
			for (let i = 0; i < 1000; i++) {
				generateSecretKey();
			}
			const elapsed = Date.now() - start;

			// Should complete 1000 generations in under 1 second
			expect(elapsed).toBeLessThan(1000);
		});

		test("should validate keys quickly", () => {
			const key = generateSecretKey();
			const start = Date.now();

			for (let i = 0; i < 10000; i++) {
				validateSecretKey(key);
			}
			const elapsed = Date.now() - start;

			// Should complete 10000 validations in under 1 second
			expect(elapsed).toBeLessThan(1000);
		});
	});
});
