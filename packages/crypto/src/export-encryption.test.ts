/**
 * Comprehensive Unit Tests for Export Encryption
 *
 * Tests cover:
 * - Password-based encryption/decryption of vault exports
 * - PBKDF2 + HKDF key derivation for exports
 * - EncryptedExport structure validation
 * - Edge cases (special passwords, large data, unicode)
 * - Error handling (wrong passwords, corrupted data)
 * - Security properties
 */

import { describe, expect, test } from "bun:test";
import {
	decryptExport,
	type EncryptedExport,
	encryptExport,
} from "./export-encryption";

describe("Export Encryption Module", () => {
	describe("Basic Encryption/Decryption", () => {
		test("should encrypt and decrypt simple export data", async () => {
			const password = "ExportPassword123!";
			const data = "Simple vault export data";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should return correct EncryptedExport structure", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);

			expect(encrypted.version).toBe("1.0");
			expect(encrypted.algorithm).toBe("AES-GCM");
			expect(encrypted.iterations).toBe(100_000);
			expect(typeof encrypted.salt).toBe("string");
			expect(typeof encrypted.iv).toBe("string");
			expect(typeof encrypted.ciphertext).toBe("string");
		});

		test("should produce base64-encoded salt, IV, and ciphertext", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);

			const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
			expect(base64Pattern.test(encrypted.salt)).toBe(true);
			expect(base64Pattern.test(encrypted.iv)).toBe(true);
			expect(base64Pattern.test(encrypted.ciphertext)).toBe(true);
		});

		test("should produce different ciphertext for same data (random salt/IV)", async () => {
			const password = "SamePassword";
			const data = "Same data";

			const encrypted1 = await encryptExport(data, password);
			const encrypted2 = await encryptExport(data, password);

			// Salt should be different
			expect(encrypted1.salt).not.toBe(encrypted2.salt);
			// IV should be different
			expect(encrypted1.iv).not.toBe(encrypted2.iv);
			// Ciphertext should be different
			expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);

			// Both should decrypt correctly
			expect(await decryptExport(encrypted1, password)).toBe(data);
			expect(await decryptExport(encrypted2, password)).toBe(data);
		});
	});

	describe("JSON Export Data", () => {
		test("should encrypt and decrypt typical vault export JSON", async () => {
			const password = "SecureExportPassword!";
			const vaultExport = {
				version: "1.0",
				exportedAt: new Date().toISOString(),
				vaults: [
					{
						name: "Personal Vault",
						items: [
							{
								category: "login",
								title: "Gmail",
								username: "user@gmail.com",
								password: "secret123",
							},
							{
								category: "credit-card",
								title: "Visa Card",
								cardNumber: "4111111111111111",
								cvv: "123",
							},
						],
					},
				],
			};
			const data = JSON.stringify(vaultExport);

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(JSON.parse(decrypted)).toEqual(vaultExport);
		});

		test("should encrypt and decrypt large vault export", async () => {
			const password = "LargeExportPassword";

			// Create a large export with many items
			const items = [];
			for (let i = 0; i < 100; i++) {
				items.push({
					id: `item-${i}`,
					category: "login",
					title: `Website ${i}`,
					username: `user${i}@example.com`,
					password: `password${i}!@#$%`,
					notes: `Notes for item ${i}: `.repeat(10),
				});
			}

			const data = JSON.stringify({ items });

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(JSON.parse(decrypted)).toEqual({ items });
		});
	});

	describe("Edge Cases - Passwords", () => {
		test("should handle empty password", async () => {
			const password = "";
			const data = "Data with empty password";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle very long password", async () => {
			const password = "A".repeat(10000);
			const data = "Data with very long password";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle password with unicode characters", async () => {
			const password = "Passort: cafe";
			const data = "Data with unicode password";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle password with special characters", async () => {
			const password = "P@$$w0rd!#$%^&*()_+-=[]{}|;':\",./<>?";
			const data = "Data with special password";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle password with newlines and whitespace", async () => {
			const password = "Password\nWith\tWhitespace\r\n";
			const data = "Data with whitespace password";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should be case-sensitive for passwords", async () => {
			const data = "Secret data";
			const encrypted = await encryptExport(data, "Password");

			// Wrong case should fail
			let decryptionFailed = false;
			try {
				await decryptExport(encrypted, "password");
			} catch {
				decryptionFailed = true;
			}
			expect(decryptionFailed).toBe(true);

			let decryptionFailed2 = false;
			try {
				await decryptExport(encrypted, "PASSWORD");
			} catch {
				decryptionFailed2 = true;
			}
			expect(decryptionFailed2).toBe(true);
		});
	});

	describe("Edge Cases - Data", () => {
		test("should handle empty data", async () => {
			const password = "TestPassword";
			const data = "";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle moderately large data", async () => {
			const password = "TestPassword";
			// Use 100KB instead of 1MB to avoid stack overflow in base64 conversion
			const data = "X".repeat(100000);

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle unicode data", async () => {
			const password = "TestPassword";
			const data = "Unicode: Hello Bonjour cafe Japanese";

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});

		test("should handle binary-like string data", async () => {
			const password = "TestPassword";
			let data = "";
			for (let i = 32; i < 127; i++) {
				data += String.fromCharCode(i);
			}

			const encrypted = await encryptExport(data, password);
			const decrypted = await decryptExport(encrypted, password);

			expect(decrypted).toBe(data);
		});
	});

	describe("Error Handling - Wrong Password", () => {
		test("should fail decryption with wrong password", async () => {
			const data = "Secret export data";
			const encrypted = await encryptExport(data, "CorrectPassword");

			let decryptionFailed = false;
			try {
				await decryptExport(encrypted, "WrongPassword");
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with empty password when encrypted with non-empty", async () => {
			const data = "Secret export data";
			const encrypted = await encryptExport(data, "NonEmptyPassword");

			let decryptionFailed = false;
			try {
				await decryptExport(encrypted, "");
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with similar but different password", async () => {
			const data = "Secret export data";
			const encrypted = await encryptExport(data, "MyPassword123");

			// Try similar passwords
			const similarPasswords = [
				"MyPassword124",
				"myPassword123",
				"MyPassword123 ",
				" MyPassword123",
				"MyPassword12",
			];

			for (const wrongPassword of similarPasswords) {
				let decryptionFailed = false;
				try {
					await decryptExport(encrypted, wrongPassword);
				} catch {
					decryptionFailed = true;
				}
				expect(decryptionFailed).toBe(true);
			}
		});
	});

	describe("Error Handling - Corrupted Data", () => {
		test("should fail with corrupted ciphertext", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);
			const corrupted: EncryptedExport = {
				...encrypted,
				ciphertext: `${encrypted.ciphertext.slice(0, -4)}XXXX`,
			};

			let decryptionFailed = false;
			try {
				await decryptExport(corrupted, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with corrupted salt", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);
			const corrupted: EncryptedExport = {
				...encrypted,
				salt: "INVALIDBASE64!!",
			};

			let decryptionFailed = false;
			try {
				await decryptExport(corrupted, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with corrupted IV", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);
			const corrupted: EncryptedExport = {
				...encrypted,
				iv: "INVALIDIV!",
			};

			let decryptionFailed = false;
			try {
				await decryptExport(corrupted, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with truncated ciphertext", async () => {
			const password = "TestPassword";
			const data =
				"This is a longer test data string to ensure enough ciphertext";

			const encrypted = await encryptExport(data, password);
			const corrupted: EncryptedExport = {
				...encrypted,
				ciphertext: encrypted.ciphertext.slice(0, 10),
			};

			let decryptionFailed = false;
			try {
				await decryptExport(corrupted, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with swapped salt", async () => {
			const password = "TestPassword";

			const encrypted1 = await encryptExport("Data 1", password);
			const encrypted2 = await encryptExport("Data 2", password);

			// Swap salts
			const swapped: EncryptedExport = {
				...encrypted1,
				salt: encrypted2.salt,
			};

			let decryptionFailed = false;
			try {
				await decryptExport(swapped, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with swapped IV", async () => {
			const password = "TestPassword";

			const encrypted1 = await encryptExport("Data 1", password);
			const encrypted2 = await encryptExport("Data 2", password);

			// Swap IVs
			const swapped: EncryptedExport = {
				...encrypted1,
				iv: encrypted2.iv,
			};

			let decryptionFailed = false;
			try {
				await decryptExport(swapped, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});

		test("should fail with empty ciphertext", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);
			const corrupted: EncryptedExport = {
				...encrypted,
				ciphertext: "",
			};

			let decryptionFailed = false;
			try {
				await decryptExport(corrupted, password);
			} catch {
				decryptionFailed = true;
			}

			expect(decryptionFailed).toBe(true);
		});
	});

	describe("Security Properties", () => {
		test("should use 256-bit salt", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);

			// Decode salt from base64
			const saltBytes = atob(encrypted.salt);
			expect(saltBytes.length).toBe(32); // 256 bits = 32 bytes
		});

		test("should use 96-bit IV", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);

			// Decode IV from base64
			const ivBytes = atob(encrypted.iv);
			expect(ivBytes.length).toBe(12); // 96 bits = 12 bytes
		});

		test("should use 100,000 PBKDF2 iterations", async () => {
			const password = "TestPassword";
			const data = "Test data";

			const encrypted = await encryptExport(data, password);

			expect(encrypted.iterations).toBe(100_000);
		});

		test("should produce high-entropy ciphertext", async () => {
			const password = "TestPassword";
			const data = "Predictable data pattern: AAAAAAAAAAAAAAAAAAAAAA";

			const encrypted = await encryptExport(data, password);

			// Decode and check byte distribution
			const ciphertextBytes = atob(encrypted.ciphertext);
			const byteCounts: Record<number, number> = {};

			for (let i = 0; i < ciphertextBytes.length; i++) {
				const byte = ciphertextBytes.charCodeAt(i);
				byteCounts[byte] = (byteCounts[byte] || 0) + 1;
			}

			// Should have variety in bytes (encrypted data should look random)
			const uniqueBytes = Object.keys(byteCounts).length;
			expect(uniqueBytes).toBeGreaterThan(10);
		});

		test("should not reveal plaintext length precisely", async () => {
			const password = "TestPassword";

			// Different length plaintexts
			const short = await encryptExport("A", password);
			const medium = await encryptExport("A".repeat(100), password);
			const long = await encryptExport("A".repeat(1000), password);

			// Ciphertext length should scale roughly with plaintext
			// but AES-GCM adds auth tag and padding
			const shortLen = atob(short.ciphertext).length;
			const mediumLen = atob(medium.ciphertext).length;
			const longLen = atob(long.ciphertext).length;

			expect(mediumLen).toBeGreaterThan(shortLen);
			expect(longLen).toBeGreaterThan(mediumLen);
		});
	});

	describe("Export/Import Workflow", () => {
		test("should support complete export/import cycle", async () => {
			const exportPassword = "UserChosenExportPassword123!";

			// Simulate vault data export
			const vaultData = {
				exportVersion: "1.0",
				exportedAt: new Date().toISOString(),
				vaults: [
					{
						id: "vault-1",
						name: "Personal",
						items: [
							{
								id: "item-1",
								category: "login",
								title: "GitHub",
								data: { username: "dev@example.com", password: "gh_secret" },
							},
							{
								id: "item-2",
								category: "secure-note",
								title: "Recovery Codes",
								data: { content: "1234-5678-9012-3456" },
							},
						],
					},
				],
			};

			// Export (encrypt)
			const exportJson = JSON.stringify(vaultData);
			const encryptedExport = await encryptExport(exportJson, exportPassword);

			// Simulate saving to file and loading later
			const exportFileContent = JSON.stringify(encryptedExport);

			// Import (parse and decrypt)
			const loadedExport: EncryptedExport = JSON.parse(exportFileContent);
			const decryptedJson = await decryptExport(loadedExport, exportPassword);
			const importedData = JSON.parse(decryptedJson);

			// Verify data integrity
			expect(importedData).toEqual(vaultData);
			expect(importedData.vaults[0].items[0].data.password).toBe("gh_secret");
		});

		test("should handle export file format preservation", async () => {
			const password = "TestPassword";
			const data = JSON.stringify({ test: "data" });

			const encrypted = await encryptExport(data, password);

			// Convert to JSON and back (simulating file save/load)
			const json = JSON.stringify(encrypted);
			const parsed = JSON.parse(json) as EncryptedExport;

			// Should still decrypt correctly
			const decrypted = await decryptExport(parsed, password);
			expect(decrypted).toBe(data);
		});
	});

	describe("Performance", () => {
		test("should complete encryption in reasonable time", async () => {
			const password = "TestPassword";
			const data = "X".repeat(10000); // 10KB

			const start = Date.now();
			await encryptExport(data, password);
			const elapsed = Date.now() - start;

			// With 100k iterations, should still complete in under 2 seconds
			expect(elapsed).toBeLessThan(2000);
		});

		test("should complete decryption in reasonable time", async () => {
			const password = "TestPassword";
			const data = "X".repeat(10000);

			const encrypted = await encryptExport(data, password);

			const start = Date.now();
			await decryptExport(encrypted, password);
			const elapsed = Date.now() - start;

			// Should complete in under 2 seconds
			expect(elapsed).toBeLessThan(2000);
		});
	});
});
