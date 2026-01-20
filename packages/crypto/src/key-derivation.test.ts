/**
 * Comprehensive Unit Tests for Key Derivation Functions
 *
 * Tests cover:
 * - PBKDF2 + HKDF key derivation
 * - Deriving authentication and master unlock keys
 * - Base64 encoding/decoding utilities
 * - Edge cases (special characters, unicode, empty inputs)
 * - Deterministic output verification
 * - Security properties (key independence, salt sensitivity)
 */

import { describe, expect, test } from "bun:test";
import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
	deriveKeys,
} from "./key-derivation";

describe("Key Derivation Module", () => {
	describe("deriveKeys Function", () => {
		test("should derive 256-bit auth key and master unlock key", async () => {
			const password = "SecurePassword123!";
			const secretKey = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";
			const email = "test@example.com";

			const keys = await deriveKeys(password, secretKey, email);

			expect(keys.authKey).toBeInstanceOf(Uint8Array);
			expect(keys.masterUnlockKey).toBeInstanceOf(Uint8Array);
			expect(keys.authKey.length).toBe(32); // 256 bits
			expect(keys.masterUnlockKey.length).toBe(32); // 256 bits
		});

		test("should produce different keys for auth and master unlock", async () => {
			const password = "TestPassword";
			const secretKey = "A3-AAAAAA-BBBBBB-CCCCC-DDDDD-EEEEE";
			const email = "user@test.com";

			const keys = await deriveKeys(password, secretKey, email);

			// Auth key and master unlock key should be different
			expect(keys.authKey).not.toEqual(keys.masterUnlockKey);
		});

		test("should produce deterministic output for same inputs", async () => {
			const password = "DeterministicTest";
			const secretKey = "A3-XYZABC-DEFGHI-JKLMN-OPQRS-TUVWX";
			const email = "deterministic@test.com";

			const keys1 = await deriveKeys(password, secretKey, email);
			const keys2 = await deriveKeys(password, secretKey, email);

			expect(keys1.authKey).toEqual(keys2.authKey);
			expect(keys1.masterUnlockKey).toEqual(keys2.masterUnlockKey);
		});

		test("should produce different keys for different passwords", async () => {
			const secretKey = "A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA";
			const email = "test@example.com";

			const keys1 = await deriveKeys("Password1", secretKey, email);
			const keys2 = await deriveKeys("Password2", secretKey, email);

			expect(keys1.authKey).not.toEqual(keys2.authKey);
			expect(keys1.masterUnlockKey).not.toEqual(keys2.masterUnlockKey);
		});

		test("should produce different keys for different secret keys", async () => {
			const password = "SamePassword";
			const email = "test@example.com";

			const keys1 = await deriveKeys(
				password,
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				email,
			);
			const keys2 = await deriveKeys(
				password,
				"A3-BBBBBB-BBBBBB-BBBBB-BBBBB-BBBBB",
				email,
			);

			expect(keys1.authKey).not.toEqual(keys2.authKey);
			expect(keys1.masterUnlockKey).not.toEqual(keys2.masterUnlockKey);
		});

		test("should produce different keys for different emails (salt)", async () => {
			const password = "SamePassword";
			const secretKey = "A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA";

			const keys1 = await deriveKeys(password, secretKey, "user1@test.com");
			const keys2 = await deriveKeys(password, secretKey, "user2@test.com");

			expect(keys1.authKey).not.toEqual(keys2.authKey);
			expect(keys1.masterUnlockKey).not.toEqual(keys2.masterUnlockKey);
		});

		test("should be case-insensitive for email (salt)", async () => {
			const password = "TestPassword";
			const secretKey = "A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA";

			const keys1 = await deriveKeys(password, secretKey, "Test@Example.COM");
			const keys2 = await deriveKeys(password, secretKey, "test@example.com");

			expect(keys1.authKey).toEqual(keys2.authKey);
			expect(keys1.masterUnlockKey).toEqual(keys2.masterUnlockKey);
		});
	});

	describe("Edge Cases - Passwords", () => {
		test("should handle empty password", async () => {
			const keys = await deriveKeys(
				"",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle very long password", async () => {
			const longPassword = "A".repeat(10000);
			const keys = await deriveKeys(
				longPassword,
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle password with unicode characters", async () => {
			const unicodePassword = "Passort: cafe";
			const keys = await deriveKeys(
				unicodePassword,
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle password with special characters", async () => {
			const specialPassword = "P@$$w0rd!#$%^&*()_+-=[]{}|;':\",./<>?";
			const keys = await deriveKeys(
				specialPassword,
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle password with newlines and tabs", async () => {
			const password = "Password\nWith\tWhitespace\r\n";
			const keys = await deriveKeys(
				password,
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should be sensitive to password case", async () => {
			const secretKey = "A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA";
			const email = "test@example.com";

			const keys1 = await deriveKeys("password", secretKey, email);
			const keys2 = await deriveKeys("PASSWORD", secretKey, email);
			const keys3 = await deriveKeys("Password", secretKey, email);

			expect(keys1.authKey).not.toEqual(keys2.authKey);
			expect(keys1.authKey).not.toEqual(keys3.authKey);
			expect(keys2.authKey).not.toEqual(keys3.authKey);
		});

		test("should be sensitive to password whitespace", async () => {
			const secretKey = "A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA";
			const email = "test@example.com";

			const keys1 = await deriveKeys("password", secretKey, email);
			const keys2 = await deriveKeys(" password", secretKey, email);
			const keys3 = await deriveKeys("password ", secretKey, email);

			expect(keys1.authKey).not.toEqual(keys2.authKey);
			expect(keys1.authKey).not.toEqual(keys3.authKey);
		});
	});

	describe("Edge Cases - Secret Key", () => {
		test("should handle empty secret key", async () => {
			const keys = await deriveKeys("TestPassword", "", "test@example.com");

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle malformed secret key", async () => {
			// Should still work, just produces different keys
			const keys = await deriveKeys(
				"TestPassword",
				"not-a-valid-secret-key",
				"test@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should be sensitive to secret key case", async () => {
			const password = "TestPassword";
			const email = "test@example.com";

			const keys1 = await deriveKeys(
				password,
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				email,
			);
			const keys2 = await deriveKeys(
				password,
				"a3-aaaaaa-aaaaaa-aaaaa-aaaaa-aaaaa",
				email,
			);

			expect(keys1.authKey).not.toEqual(keys2.authKey);
		});
	});

	describe("Edge Cases - Email (Salt)", () => {
		test("should handle empty email", async () => {
			const keys = await deriveKeys(
				"TestPassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle email with plus addressing", async () => {
			const keys = await deriveKeys(
				"TestPassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"user+tag@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});

		test("should handle email with unicode domain", async () => {
			const keys = await deriveKeys(
				"TestPassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"user@example.com",
			);

			expect(keys.authKey.length).toBe(32);
			expect(keys.masterUnlockKey.length).toBe(32);
		});
	});

	describe("Security Properties", () => {
		test("should produce high-entropy keys", async () => {
			const keys = await deriveKeys(
				"SimplePassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			// Check that keys are not all zeros or all ones
			const allZerosAuth = keys.authKey.every((byte) => byte === 0);
			const allOnesAuth = keys.authKey.every((byte) => byte === 255);
			const allZerosMUK = keys.masterUnlockKey.every((byte) => byte === 0);
			const allOnesMUK = keys.masterUnlockKey.every((byte) => byte === 255);

			expect(allZerosAuth).toBe(false);
			expect(allOnesAuth).toBe(false);
			expect(allZerosMUK).toBe(false);
			expect(allOnesMUK).toBe(false);

			// Check byte distribution - should have some variety
			const uniqueAuthBytes = new Set(keys.authKey).size;
			const uniqueMUKBytes = new Set(keys.masterUnlockKey).size;

			// With 32 bytes, we expect reasonable variety
			expect(uniqueAuthBytes).toBeGreaterThan(8);
			expect(uniqueMUKBytes).toBeGreaterThan(8);
		});

		test("should have independent auth key and master unlock key", async () => {
			// Keys should be derived independently using different HKDF info strings
			const keys = await deriveKeys(
				"TestPassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			// Count matching bytes (should be low due to independence)
			let matchingBytes = 0;
			for (let i = 0; i < 32; i++) {
				if (keys.authKey[i] === keys.masterUnlockKey[i]) {
					matchingBytes++;
				}
			}

			// Statistically, random 32-byte arrays would have ~0.125 matching bytes
			// Allow for some coincidental matches but not too many
			expect(matchingBytes).toBeLessThan(16);
		});
	});

	describe("Base64 Encoding/Decoding Utilities", () => {
		test("should encode empty array", () => {
			const empty = new Uint8Array(0);
			const encoded = arrayBufferToBase64(empty);
			expect(encoded).toBe("");
		});

		test("should decode empty string", () => {
			const decoded = base64ToArrayBuffer("");
			expect(decoded.length).toBe(0);
		});

		test("should encode and decode single byte", () => {
			const data = new Uint8Array([65]); // 'A'
			const encoded = arrayBufferToBase64(data);
			const decoded = base64ToArrayBuffer(encoded);
			expect(decoded).toEqual(data);
		});

		test("should encode and decode multiple bytes", () => {
			const data = new Uint8Array([72, 101, 108, 108, 111]); // 'Hello'
			const encoded = arrayBufferToBase64(data);
			const decoded = base64ToArrayBuffer(encoded);
			expect(decoded).toEqual(data);
		});

		test("should handle all byte values 0-255", () => {
			const data = new Uint8Array(256);
			for (let i = 0; i < 256; i++) {
				data[i] = i;
			}

			const encoded = arrayBufferToBase64(data);
			const decoded = base64ToArrayBuffer(encoded);

			expect(decoded).toEqual(data);
		});

		test("should produce valid base64 output", () => {
			const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
			const encoded = arrayBufferToBase64(data);

			// Base64 pattern: alphanumeric + / and optional = padding
			const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
			expect(base64Pattern.test(encoded)).toBe(true);
		});

		test("should encode encryption keys correctly", async () => {
			const keys = await deriveKeys(
				"TestPassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			const authKeyBase64 = arrayBufferToBase64(keys.authKey);
			const mukBase64 = arrayBufferToBase64(keys.masterUnlockKey);

			// Should be valid base64
			const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
			expect(base64Pattern.test(authKeyBase64)).toBe(true);
			expect(base64Pattern.test(mukBase64)).toBe(true);

			// Should decode back to original
			expect(base64ToArrayBuffer(authKeyBase64)).toEqual(keys.authKey);
			expect(base64ToArrayBuffer(mukBase64)).toEqual(keys.masterUnlockKey);
		});

		test("should handle round-trip with random data", () => {
			for (let size = 1; size <= 100; size += 10) {
				const data = new Uint8Array(size);
				crypto.getRandomValues(data);

				const encoded = arrayBufferToBase64(data);
				const decoded = base64ToArrayBuffer(encoded);

				expect(decoded).toEqual(data);
			}
		});
	});

	describe("Integration with Encryption", () => {
		test("should derive keys usable for AES-256-GCM encryption", async () => {
			const keys = await deriveKeys(
				"TestPassword",
				"A3-AAAAAA-AAAAAA-AAAAA-AAAAA-AAAAA",
				"test@example.com",
			);

			// Verify key can be imported for AES-GCM
			const cryptoKey = await crypto.subtle.importKey(
				"raw",
				new Uint8Array(keys.masterUnlockKey),
				{ name: "AES-GCM", length: 256 },
				false,
				["encrypt", "decrypt"],
			);

			expect(cryptoKey).toBeDefined();
			expect(cryptoKey.algorithm.name).toBe("AES-GCM");
		});

		test("should derive consistent keys for vault key encryption", async () => {
			const password = "UserPassword123!";
			const secretKey = "A3-BCDEFG-HIJKLM-NOPQR-STUVW-XYZ23";
			const email = "user@vaulttest.com";

			// Derive keys multiple times
			const keys1 = await deriveKeys(password, secretKey, email);
			const keys2 = await deriveKeys(password, secretKey, email);

			// Should be able to encrypt with one and decrypt with other
			const testData = "Vault key to encrypt";
			const iv = crypto.getRandomValues(new Uint8Array(12));

			const cryptoKey1 = await crypto.subtle.importKey(
				"raw",
				new Uint8Array(keys1.masterUnlockKey),
				{ name: "AES-GCM", length: 256 },
				false,
				["encrypt"],
			);

			const encrypted = await crypto.subtle.encrypt(
				{ name: "AES-GCM", iv },
				cryptoKey1,
				new TextEncoder().encode(testData),
			);

			const cryptoKey2 = await crypto.subtle.importKey(
				"raw",
				new Uint8Array(keys2.masterUnlockKey),
				{ name: "AES-GCM", length: 256 },
				false,
				["decrypt"],
			);

			const decrypted = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv },
				cryptoKey2,
				encrypted,
			);

			expect(new TextDecoder().decode(decrypted)).toBe(testData);
		});
	});
});
