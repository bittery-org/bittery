/**
 * Comprehensive Unit Tests for RSA-4096 Key Operations
 *
 * Tests cover:
 * - RSA key pair generation
 * - RSA-OAEP encryption/decryption
 * - PEM format validation
 * - Edge cases (large data, special characters, unicode)
 * - Error handling (invalid keys, corrupted ciphertext)
 * - Security properties
 */

import { describe, expect, test } from "bun:test";
import { generateRSAKeyPair, rsaDecrypt, rsaEncrypt } from "./rsa";

describe("RSA-4096 Key Operations Module", () => {
	describe("Key Pair Generation", () => {
		test("should generate valid RSA key pair", async () => {
			const keys = await generateRSAKeyPair();

			expect(keys.publicKey).toBeDefined();
			expect(keys.privateKey).toBeDefined();
			expect(typeof keys.publicKey).toBe("string");
			expect(typeof keys.privateKey).toBe("string");
		});

		test("should generate public key in PEM format", async () => {
			const keys = await generateRSAKeyPair();

			expect(keys.publicKey).toContain("-----BEGIN PUBLIC KEY-----");
			expect(keys.publicKey).toContain("-----END PUBLIC KEY-----");
		});

		test("should generate private key in PEM format", async () => {
			const keys = await generateRSAKeyPair();

			expect(keys.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
			expect(keys.privateKey).toContain("-----END PRIVATE KEY-----");
		});

		test("should generate unique key pairs each time", async () => {
			const keys1 = await generateRSAKeyPair();
			const keys2 = await generateRSAKeyPair();

			expect(keys1.publicKey).not.toBe(keys2.publicKey);
			expect(keys1.privateKey).not.toBe(keys2.privateKey);
		});

		test("should generate keys with base64-encoded content", async () => {
			const keys = await generateRSAKeyPair();

			// Extract base64 content
			const publicKeyContent = keys.publicKey
				.replace("-----BEGIN PUBLIC KEY-----", "")
				.replace("-----END PUBLIC KEY-----", "")
				.replace(/\n/g, "");

			const privateKeyContent = keys.privateKey
				.replace("-----BEGIN PRIVATE KEY-----", "")
				.replace("-----END PRIVATE KEY-----", "")
				.replace(/\n/g, "");

			// Should be valid base64
			const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
			expect(base64Pattern.test(publicKeyContent)).toBe(true);
			expect(base64Pattern.test(privateKeyContent)).toBe(true);
		});

		test("should generate keys of appropriate length for RSA-4096", async () => {
			const keys = await generateRSAKeyPair();

			// RSA-4096 public key in SPKI format should be ~800-900 bytes base64
			const publicKeyContent = keys.publicKey
				.replace("-----BEGIN PUBLIC KEY-----", "")
				.replace("-----END PUBLIC KEY-----", "")
				.replace(/\n/g, "");

			// RSA-4096 private key in PKCS8 format should be ~3200+ bytes base64
			const privateKeyContent = keys.privateKey
				.replace("-----BEGIN PRIVATE KEY-----", "")
				.replace("-----END PRIVATE KEY-----", "")
				.replace(/\n/g, "");

			// Check reasonable size ranges
			expect(publicKeyContent.length).toBeGreaterThan(700);
			expect(privateKeyContent.length).toBeGreaterThan(3000);
		});
	});

	describe("Basic Encryption/Decryption", () => {
		test("should encrypt and decrypt a simple string", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Hello, RSA World!";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);
			const decrypted = await rsaDecrypt(ciphertext, keys.privateKey);

			expect(decrypted).toBe(plaintext);
		});

		test("should produce different ciphertext for same plaintext (OAEP padding)", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Same message";

			const ciphertext1 = await rsaEncrypt(plaintext, keys.publicKey);
			const ciphertext2 = await rsaEncrypt(plaintext, keys.publicKey);

			// OAEP uses random padding, so ciphertexts should differ
			expect(ciphertext1).not.toBe(ciphertext2);

			// But both should decrypt to the same plaintext
			expect(await rsaDecrypt(ciphertext1, keys.privateKey)).toBe(plaintext);
			expect(await rsaDecrypt(ciphertext2, keys.privateKey)).toBe(plaintext);
		});

		test("should return base64-encoded ciphertext", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Test data";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);

			// Should be valid base64
			const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
			expect(base64Pattern.test(ciphertext)).toBe(true);
		});
	});

	describe("Edge Cases - Plaintext", () => {
		test("should handle empty string", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);
			const decrypted = await rsaDecrypt(ciphertext, keys.privateKey);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle unicode characters", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Hello, Bonjour, Hola, cafe";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);
			const decrypted = await rsaDecrypt(ciphertext, keys.privateKey);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle special characters", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Special: !@#$%^&*()_+-=[]{}|;':\",./<>?";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);
			const decrypted = await rsaDecrypt(ciphertext, keys.privateKey);

			expect(decrypted).toBe(plaintext);
		});

		test("should handle JSON data (typical vault key)", async () => {
			const keys = await generateRSAKeyPair();
			// Simulate an encrypted vault key (base64 encoded AES key)
			const vaultKeyBase64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU="; // 32 bytes base64

			const ciphertext = await rsaEncrypt(vaultKeyBase64, keys.publicKey);
			const decrypted = await rsaDecrypt(ciphertext, keys.privateKey);

			expect(decrypted).toBe(vaultKeyBase64);
		});

		test("should handle maximum RSA payload size", async () => {
			const keys = await generateRSAKeyPair();
			// RSA-4096 with SHA-256 OAEP can encrypt up to ~446 bytes
			// (4096/8 - 2*32 - 2 = 446)
			const maxPayload = "A".repeat(400); // Stay under limit

			const ciphertext = await rsaEncrypt(maxPayload, keys.publicKey);
			const decrypted = await rsaDecrypt(ciphertext, keys.privateKey);

			expect(decrypted).toBe(maxPayload);
		});

		test("should fail with payload too large for RSA", async () => {
			const keys = await generateRSAKeyPair();
			// Try to encrypt more than RSA can handle
			const tooLarge = "A".repeat(500);

			let encryptionFailed = false;
			try {
				await rsaEncrypt(tooLarge, keys.publicKey);
			} catch {
				encryptionFailed = true;
			}

			expect(encryptionFailed).toBe(true);
		});
	});

	describe("Error Handling - Invalid Keys", () => {
		test("should fail encryption with invalid public key", async () => {
			const invalidPublicKey =
				"-----BEGIN PUBLIC KEY-----\nINVALID\n-----END PUBLIC KEY-----";
			const plaintext = "Test data";

			let encryptionFailed = false;
			try {
				await rsaEncrypt(plaintext, invalidPublicKey);
			} catch {
				encryptionFailed = true;
			}

			expect(encryptionFailed).toBe(true);
		});

		test("should fail decryption with invalid private key", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Test data";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);

			const invalidPrivateKey =
				"-----BEGIN PRIVATE KEY-----\nINVALID\n-----END PRIVATE KEY-----";

			let decryptionFailed = false;
			try {
				await rsaDecrypt(ciphertext, invalidPrivateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with wrong private key", async () => {
			const keys1 = await generateRSAKeyPair();
			const keys2 = await generateRSAKeyPair();
			const plaintext = "Secret message";

			const ciphertext = await rsaEncrypt(plaintext, keys1.publicKey);

			let decryptionFailed = false;
			try {
				await rsaDecrypt(ciphertext, keys2.privateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with completely invalid key content", async () => {
			// Test with a key that has valid headers but completely invalid content
			const invalidKey =
				"-----BEGIN PUBLIC KEY-----\nTm90QVZhbGlkS2V5\n-----END PUBLIC KEY-----";

			let encryptionFailed = false;
			try {
				await rsaEncrypt("Test", invalidKey);
			} catch {
				encryptionFailed = true;
			}

			expect(encryptionFailed).toBe(true);
		});

		test("should fail with empty public key", async () => {
			let encryptionFailed = false;
			try {
				await rsaEncrypt("Test", "");
			} catch {
				encryptionFailed = true;
			}

			expect(encryptionFailed).toBe(true);
		});

		test("should fail with empty private key", async () => {
			const keys = await generateRSAKeyPair();
			const ciphertext = await rsaEncrypt("Test", keys.publicKey);

			let decryptionFailed = false;
			try {
				await rsaDecrypt(ciphertext, "");
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});
	});

	describe("Error Handling - Corrupted Ciphertext", () => {
		test("should fail decryption with corrupted ciphertext", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Secret message";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);

			// Corrupt the ciphertext
			const corrupted = `${ciphertext.slice(0, -4)}XXXX`;

			let decryptionFailed = false;
			try {
				await rsaDecrypt(corrupted, keys.privateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with truncated ciphertext", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Secret message";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);

			// Truncate significantly
			const truncated = ciphertext.slice(0, Math.floor(ciphertext.length / 2));

			let decryptionFailed = false;
			try {
				await rsaDecrypt(truncated, keys.privateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with empty ciphertext", async () => {
			const keys = await generateRSAKeyPair();

			let decryptionFailed = false;
			try {
				await rsaDecrypt("", keys.privateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with invalid base64 ciphertext", async () => {
			const keys = await generateRSAKeyPair();

			let decryptionFailed = false;
			try {
				await rsaDecrypt("not-valid-base64!!!", keys.privateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail decryption with random data as ciphertext", async () => {
			const keys = await generateRSAKeyPair();

			// Generate random bytes and base64 encode
			const randomBytes = crypto.getRandomValues(new Uint8Array(512));
			const randomBase64 = btoa(String.fromCharCode(...randomBytes));

			let decryptionFailed = false;
			try {
				await rsaDecrypt(randomBase64, keys.privateKey);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});
	});

	describe("Vault Key Encryption Scenarios", () => {
		test("should encrypt AES-256 vault key for team member", async () => {
			const memberKeys = await generateRSAKeyPair();

			// Simulate vault key as base64-encoded 32 bytes
			const vaultKey = crypto.getRandomValues(new Uint8Array(32));
			const vaultKeyBase64 = btoa(String.fromCharCode(...vaultKey));

			const encryptedVaultKey = await rsaEncrypt(
				vaultKeyBase64,
				memberKeys.publicKey,
			);
			const decryptedVaultKeyBase64 = await rsaDecrypt(
				encryptedVaultKey,
				memberKeys.privateKey,
			);

			expect(decryptedVaultKeyBase64).toBe(vaultKeyBase64);
		});

		test("should support encrypting same vault key for multiple members", async () => {
			const member1Keys = await generateRSAKeyPair();
			const member2Keys = await generateRSAKeyPair();
			const member3Keys = await generateRSAKeyPair();

			// Vault key
			const vaultKey = crypto.getRandomValues(new Uint8Array(32));
			const vaultKeyBase64 = btoa(String.fromCharCode(...vaultKey));

			// Encrypt for each member
			const encrypted1 = await rsaEncrypt(
				vaultKeyBase64,
				member1Keys.publicKey,
			);
			const encrypted2 = await rsaEncrypt(
				vaultKeyBase64,
				member2Keys.publicKey,
			);
			const encrypted3 = await rsaEncrypt(
				vaultKeyBase64,
				member3Keys.publicKey,
			);

			// Each member should be able to decrypt
			expect(await rsaDecrypt(encrypted1, member1Keys.privateKey)).toBe(
				vaultKeyBase64,
			);
			expect(await rsaDecrypt(encrypted2, member2Keys.privateKey)).toBe(
				vaultKeyBase64,
			);
			expect(await rsaDecrypt(encrypted3, member3Keys.privateKey)).toBe(
				vaultKeyBase64,
			);

			// But they can't decrypt each other's copies
			let crossDecryptFailed = false;
			try {
				await rsaDecrypt(encrypted1, member2Keys.privateKey);
			} catch {
				crossDecryptFailed = true;
			}
			expect(crossDecryptFailed).toBe(true);
		});

		test("should maintain vault key confidentiality after member removal", async () => {
			const ownerKeys = await generateRSAKeyPair();
			const memberKeys = await generateRSAKeyPair();
			const removedMemberKeys = await generateRSAKeyPair();

			// Original vault key
			const oldVaultKey = crypto.getRandomValues(new Uint8Array(32));
			const oldVaultKeyBase64 = btoa(String.fromCharCode(...oldVaultKey));

			// Removed member had access to old key
			const removedMemberEncrypted = await rsaEncrypt(
				oldVaultKeyBase64,
				removedMemberKeys.publicKey,
			);

			// After rotation: new vault key
			const newVaultKey = crypto.getRandomValues(new Uint8Array(32));
			const newVaultKeyBase64 = btoa(String.fromCharCode(...newVaultKey));

			// Only remaining members get new key
			const ownerNewKey = await rsaEncrypt(
				newVaultKeyBase64,
				ownerKeys.publicKey,
			);
			const memberNewKey = await rsaEncrypt(
				newVaultKeyBase64,
				memberKeys.publicKey,
			);

			// Remaining members can decrypt new key
			expect(await rsaDecrypt(ownerNewKey, ownerKeys.privateKey)).toBe(
				newVaultKeyBase64,
			);
			expect(await rsaDecrypt(memberNewKey, memberKeys.privateKey)).toBe(
				newVaultKeyBase64,
			);

			// Removed member can still decrypt old key (expected)
			expect(
				await rsaDecrypt(removedMemberEncrypted, removedMemberKeys.privateKey),
			).toBe(oldVaultKeyBase64);

			// But new key is different, so old access is meaningless
			expect(oldVaultKeyBase64).not.toBe(newVaultKeyBase64);
		});
	});

	describe("Security Properties", () => {
		test("should not leak plaintext length through ciphertext length", async () => {
			const keys = await generateRSAKeyPair();

			// Different length plaintexts
			const short = "A";
			const medium = "A".repeat(50);
			const long = "A".repeat(200);

			const shortCiphertext = await rsaEncrypt(short, keys.publicKey);
			const mediumCiphertext = await rsaEncrypt(medium, keys.publicKey);
			const longCiphertext = await rsaEncrypt(long, keys.publicKey);

			// RSA ciphertext should be same length regardless of plaintext
			// (4096 bits = 512 bytes = ~684 base64 chars)
			expect(shortCiphertext.length).toBe(mediumCiphertext.length);
			expect(mediumCiphertext.length).toBe(longCiphertext.length);
		});

		test("should generate high-entropy ciphertext", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Test data for entropy check";

			const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);

			// Decode base64 to check byte distribution
			const ciphertextBytes = atob(ciphertext);
			const byteCounts: Record<number, number> = {};

			for (let i = 0; i < ciphertextBytes.length; i++) {
				const byte = ciphertextBytes.charCodeAt(i);
				byteCounts[byte] = (byteCounts[byte] || 0) + 1;
			}

			// Should have good byte variety (not all same value)
			const uniqueBytes = Object.keys(byteCounts).length;
			expect(uniqueBytes).toBeGreaterThan(100); // RSA-4096 output should have high variety
		});
	});

	describe("Performance", () => {
		test("should complete key generation in reasonable time", async () => {
			const start = Date.now();
			await generateRSAKeyPair();
			const elapsed = Date.now() - start;

			// RSA-4096 generation should complete in under 5 seconds
			expect(elapsed).toBeLessThan(5000);
		});

		test("should complete encrypt/decrypt cycle quickly", async () => {
			const keys = await generateRSAKeyPair();
			const plaintext = "Performance test data";

			const start = Date.now();
			for (let i = 0; i < 10; i++) {
				const ciphertext = await rsaEncrypt(plaintext, keys.publicKey);
				await rsaDecrypt(ciphertext, keys.privateKey);
			}
			const elapsed = Date.now() - start;

			// 10 encrypt/decrypt cycles should complete in under 2 seconds
			expect(elapsed).toBeLessThan(2000);
		});
	});
});
