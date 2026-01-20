/**
 * Comprehensive Unit Tests for AES-256-GCM Encryption/Decryption
 *
 * Tests cover:
 * - Basic encryption/decryption functionality
 * - Key generation and validation
 * - Edge cases (empty strings, large data, unicode, special chars)
 * - Error handling (corrupted data, invalid keys, malformed ciphertext)
 * - Data integrity verification
 */

import { describe, expect, test } from "bun:test";
import { decrypt, encrypt, generateEncryptionKey } from "./encryption";
import type { EncryptedData } from "./encryption";

describe("AES-256-GCM Encryption Module", () => {
	describe("Key Generation", () => {
		test("should generate a 256-bit (32-byte) encryption key", () => {
			const key = generateEncryptionKey();
			expect(key).toBeInstanceOf(Uint8Array);
			expect(key.length).toBe(32); // 256 bits = 32 bytes
		});

		test("should generate unique keys each time", () => {
			const key1 = generateEncryptionKey();
			const key2 = generateEncryptionKey();
			const key3 = generateEncryptionKey();

			// Keys should be different (probability of collision is negligible)
			expect(key1).not.toEqual(key2);
			expect(key2).not.toEqual(key3);
			expect(key1).not.toEqual(key3);
		});

		test("should generate cryptographically random keys", () => {
			// Generate multiple keys and verify they have good entropy
			const keys: Uint8Array[] = [];
			for (let i = 0; i < 10; i++) {
				keys.push(generateEncryptionKey());
			}

			// Check that no keys are all zeros or all ones (basic entropy check)
			for (const key of keys) {
				const allZeros = key.every((byte) => byte === 0);
				const allOnes = key.every((byte) => byte === 255);
				expect(allZeros).toBe(false);
				expect(allOnes).toBe(false);
			}
		});
	});

	describe("Basic Encryption/Decryption", () => {
		test("should encrypt and decrypt a simple string", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Hello, World!";

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});

		test("should produce different ciphertext for same plaintext (due to random IV)", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Same message";

			const encrypted1 = await encrypt(plaintext, key);
			const encrypted2 = await encrypt(plaintext, key);

			// Ciphertexts should be different due to random IV
			expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
			expect(encrypted1.iv).not.toBe(encrypted2.iv);
		});

		test("should return correct algorithm in encrypted data", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Test data";

			const encrypted = await encrypt(plaintext, key);

			expect(encrypted.algorithm).toBe("AES-GCM");
		});

		test("should return base64 encoded ciphertext and IV", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Test data";

			const encrypted = await encrypt(plaintext, key);

			// Base64 regex pattern
			const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
			expect(base64Pattern.test(encrypted.ciphertext)).toBe(true);
			expect(base64Pattern.test(encrypted.iv)).toBe(true);
		});
	});

	describe("Edge Cases", () => {
		test("should handle empty string encryption", async () => {
			const key = generateEncryptionKey();
			const plaintext = "";

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle very long strings", async () => {
			const key = generateEncryptionKey();
			const plaintext = "A".repeat(100000); // 100KB of data

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle unicode characters", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Hello, World! Bonjour, Monde! Hallo, Welt! Ciao, Mondo!";

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle emojis", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Hello! Goodbye! Warning!";

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle special characters and control chars", async () => {
			const key = generateEncryptionKey();
			const plaintext =
				"Special chars: !@#$%^&*()_+-=[]{}|;':\",./<>?\n\t\r\\";

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle JSON data", async () => {
			const key = generateEncryptionKey();
			const data = {
				title: "Test Login",
				username: "test@example.com",
				password: "supersecret123!@#",
				notes: "Some notes with unicode: cafe",
			};
			const plaintext = JSON.stringify(data);

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
			expect(JSON.parse(decrypted)).toEqual(data);
		});

		test("should handle binary-like string content", async () => {
			const key = generateEncryptionKey();
			// Create a string with various byte values
			let plaintext = "";
			for (let i = 32; i < 127; i++) {
				plaintext += String.fromCharCode(i);
			}

			const encrypted = await encrypt(plaintext, key);
			const decrypted = await decrypt(encrypted, key);

			expect(decrypted).toBe(plaintext);
		});
	});

	describe("Error Handling - Invalid Keys", () => {
		test("should fail decryption with wrong key", async () => {
			const key1 = generateEncryptionKey();
			const key2 = generateEncryptionKey();
			const plaintext = "Secret message";

			const encrypted = await encrypt(plaintext, key1);

			let decryptionFailed = false;
			try {
				await decrypt(encrypted, key2);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should handle key of wrong length gracefully", async () => {
			// Note: Web Crypto API behavior with wrong key lengths can vary
			// Some implementations accept the key, others reject it
			// The important thing is that keys of wrong length cannot decrypt
			// data encrypted with a proper 256-bit key
			const shortKey = new Uint8Array(16); // 128-bit key
			crypto.getRandomValues(shortKey);

			const correctKey = generateEncryptionKey(); // 256-bit
			const plaintext = "Test data";

			// Encrypt with correct key
			const encrypted = await encrypt(plaintext, correctKey);

			// Try to decrypt with wrong-length key should fail
			let decryptionFailed = false;
			try {
				await decrypt(encrypted, shortKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with all-zero key that has been tampered", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Secret data";

			const encrypted = await encrypt(plaintext, key);

			// Create a zero key
			const zeroKey = new Uint8Array(32);

			let decryptionFailed = false;
			try {
				await decrypt(encrypted, zeroKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});
	});

	describe("Error Handling - Corrupted Data", () => {
		test("should fail decryption with corrupted ciphertext", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Secret message";

			const encrypted = await encrypt(plaintext, key);

			// Corrupt the ciphertext by changing a character
			const corruptedCiphertext =
				encrypted.ciphertext.slice(0, -4) + "XXXX";

			const corruptedData: EncryptedData = {
				...encrypted,
				ciphertext: corruptedCiphertext,
			};

			let decryptionFailed = false;
			try {
				await decrypt(corruptedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with corrupted IV", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Secret message";

			const encrypted = await encrypt(plaintext, key);

			// Corrupt the IV
			const corruptedData: EncryptedData = {
				...encrypted,
				iv: "INVALIDIV====",
			};

			let decryptionFailed = false;
			try {
				await decrypt(corruptedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with truncated ciphertext", async () => {
			const key = generateEncryptionKey();
			const plaintext = "This is a longer secret message to ensure sufficient ciphertext";

			const encrypted = await encrypt(plaintext, key);

			// Truncate the ciphertext
			const truncatedData: EncryptedData = {
				...encrypted,
				ciphertext: encrypted.ciphertext.slice(0, 10),
			};

			let decryptionFailed = false;
			try {
				await decrypt(truncatedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with empty ciphertext", async () => {
			const key = generateEncryptionKey();

			const emptyData: EncryptedData = {
				ciphertext: "",
				iv: "dGVzdGl2MTIz", // some base64 IV
				algorithm: "AES-GCM",
			};

			let decryptionFailed = false;
			try {
				await decrypt(emptyData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with swapped IV from different encryption", async () => {
			const key = generateEncryptionKey();
			const plaintext1 = "Message 1";
			const plaintext2 = "Message 2";

			const encrypted1 = await encrypt(plaintext1, key);
			const encrypted2 = await encrypt(plaintext2, key);

			// Swap the IVs
			const swappedData: EncryptedData = {
				...encrypted1,
				iv: encrypted2.iv, // Use IV from different encryption
			};

			let decryptionFailed = false;
			try {
				await decrypt(swappedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});
	});

	describe("Error Handling - Malformed Data", () => {
		test("should fail with invalid base64 ciphertext", async () => {
			const key = generateEncryptionKey();

			const malformedData: EncryptedData = {
				ciphertext: "not-valid-base64!!!",
				iv: "dGVzdGl2MTIz",
				algorithm: "AES-GCM",
			};

			let decryptionFailed = false;
			try {
				await decrypt(malformedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with invalid base64 IV", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Test data";

			const encrypted = await encrypt(plaintext, key);

			const malformedData: EncryptedData = {
				...encrypted,
				iv: "not-valid-base64!!!",
			};

			let decryptionFailed = false;
			try {
				await decrypt(malformedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});
	});

	describe("Data Integrity", () => {
		test("should detect single-bit modification in ciphertext", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Sensitive data that must not be tampered with";

			const encrypted = await encrypt(plaintext, key);

			// Decode, flip one bit, re-encode
			const ciphertextBytes = atob(encrypted.ciphertext);
			const modified = new Uint8Array(ciphertextBytes.length);
			for (let i = 0; i < ciphertextBytes.length; i++) {
				modified[i] = ciphertextBytes.charCodeAt(i);
			}
			// Flip one bit in the middle
			modified[Math.floor(modified.length / 2)] ^= 0x01;

			const modifiedBase64 = btoa(String.fromCharCode(...modified));

			const tamperedData: EncryptedData = {
				...encrypted,
				ciphertext: modifiedBase64,
			};

			let decryptionFailed = false;
			try {
				await decrypt(tamperedData, key);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should produce consistent results with same key and IV (deterministic test)", async () => {
			const key = generateEncryptionKey();
			const plaintext = "Consistent data";

			// Encrypt and decrypt multiple times
			for (let i = 0; i < 5; i++) {
				const encrypted = await encrypt(plaintext, key);
				const decrypted = await decrypt(encrypted, key);
				expect(decrypted).toBe(plaintext);
			}
		});
	});

	describe("Vault Item Encryption Scenarios", () => {
		test("should encrypt and decrypt a typical login item", async () => {
			const vaultKey = generateEncryptionKey();
			const loginItem = {
				category: "login",
				title: "Gmail Account",
				website: "https://mail.google.com",
				username: "user@gmail.com",
				password: "MyS3cur3P@ssw0rd!",
				totpSecret: "JBSWY3DPEHPK3PXP",
				notes: "Personal email account",
				customFields: [
					{ name: "Recovery Email", value: "backup@example.com" },
				],
			};

			const plaintext = JSON.stringify(loginItem);
			const encrypted = await encrypt(plaintext, vaultKey);
			const decrypted = await decrypt(encrypted, vaultKey);

			expect(JSON.parse(decrypted)).toEqual(loginItem);
		});

		test("should encrypt and decrypt a credit card item", async () => {
			const vaultKey = generateEncryptionKey();
			const cardItem = {
				category: "credit-card",
				title: "Main Credit Card",
				cardholderName: "John Doe",
				cardNumber: "4111111111111111",
				expiryMonth: "12",
				expiryYear: "2025",
				cvv: "123",
				pin: "1234",
			};

			const plaintext = JSON.stringify(cardItem);
			const encrypted = await encrypt(plaintext, vaultKey);
			const decrypted = await decrypt(encrypted, vaultKey);

			expect(JSON.parse(decrypted)).toEqual(cardItem);
		});

		test("should encrypt and decrypt an identity item", async () => {
			const vaultKey = generateEncryptionKey();
			const identityItem = {
				category: "identity",
				title: "Personal Identity",
				firstName: "John",
				lastName: "Doe",
				email: "john.doe@example.com",
				phone: "+1-555-555-5555",
				address: {
					street: "123 Main St",
					city: "Anytown",
					state: "CA",
					zip: "12345",
					country: "USA",
				},
				ssn: "123-45-6789",
				passport: "AB1234567",
			};

			const plaintext = JSON.stringify(identityItem);
			const encrypted = await encrypt(plaintext, vaultKey);
			const decrypted = await decrypt(encrypted, vaultKey);

			expect(JSON.parse(decrypted)).toEqual(identityItem);
		});

		test("should encrypt and decrypt a secure note", async () => {
			const vaultKey = generateEncryptionKey();
			const noteItem = {
				category: "secure-note",
				title: "Important Notes",
				content: `This is a secure note with multiple lines.

It contains:
- Private information
- Secret codes: ABC-123-XYZ
- Unicode: cafe

End of note.`,
			};

			const plaintext = JSON.stringify(noteItem);
			const encrypted = await encrypt(plaintext, vaultKey);
			const decrypted = await decrypt(encrypted, vaultKey);

			expect(JSON.parse(decrypted)).toEqual(noteItem);
		});
	});
});
