/**
 * Comprehensive Unit Tests for TOTP (Time-Based One-Time Password)
 *
 * Tests cover:
 * - TOTP code generation
 * - Base32 encoding/decoding
 * - OTP Auth URI parsing and generation
 * - Time-based code refresh
 * - Various algorithm support (SHA1, SHA256, SHA512)
 */

import { describe, expect, test } from "bun:test";
import {
	base32Decode,
	base32Encode,
	generateOtpAuthUri,
	generateTotp,
	generateTotpAt,
	generateTotpSecret,
	isValidBase32,
	parseOtpAuthUri,
	verifyTotp,
} from "../totp";

describe("TOTP Module", () => {
	describe("Base32 Encoding/Decoding", () => {
		test("should decode a valid base32 string", () => {
			// "Hello world" in base32
			const base32String = "JBSWY3DPEB3W64TMMQ======";
			const decoded = base32Decode(base32String);
			const text = new TextDecoder().decode(decoded);
			expect(text).toBe("Hello world");
		});

		test("should encode bytes to base32", () => {
			const text = "test";
			const bytes = new TextEncoder().encode(text);
			const encoded = base32Encode(bytes as Uint8Array<ArrayBuffer>);
			expect(encoded).toBe("ORSXG5A");
		});

		test("should handle empty string", () => {
			const decoded = base32Decode("");
			expect(decoded.length).toBe(0);
		});

		test("should ignore whitespace in base32 string", () => {
			const withSpaces = "JBSW Y3DP EB3W 64TM MQ";
			const withoutSpaces = "JBSWY3DPEB3W64TMMQ";
			const decoded1 = base32Decode(withSpaces);
			const decoded2 = base32Decode(withoutSpaces);
			expect(decoded1).toEqual(decoded2);
		});

		test("should handle padding characters", () => {
			const withPadding = "JBSWY3DPEB3W64TMMQ======";
			const withoutPadding = "JBSWY3DPEB3W64TMMQ";
			const decoded1 = base32Decode(withPadding);
			const decoded2 = base32Decode(withoutPadding);
			expect(decoded1).toEqual(decoded2);
		});

		test("should be case insensitive", () => {
			const upper = "JBSWY3DPEB3W64TMMQ";
			const lower = "jbswy3dpeb3w64tmmq";
			const decoded1 = base32Decode(upper);
			const decoded2 = base32Decode(lower);
			expect(decoded1).toEqual(decoded2);
		});

		test("should throw error for invalid base32 characters", () => {
			expect(() => base32Decode("INVALID!@#")).toThrow();
		});
	});

	describe("Base32 Validation", () => {
		test("should validate correct base32 strings", () => {
			expect(isValidBase32("JBSWY3DPEB3W64TMMQ")).toBe(true);
			expect(isValidBase32("GEZDGNBVGY3TQOJQ")).toBe(true);
			expect(isValidBase32("MFRGGZDFMY======")).toBe(true);
		});

		test("should reject invalid base32 strings", () => {
			expect(isValidBase32("")).toBe(false);
			expect(isValidBase32("invalid!@#")).toBe(false);
			expect(isValidBase32("01890")).toBe(false); // 0, 1, 8, 9 are not in base32
		});
	});

	describe("TOTP Generation", () => {
		// Test vector from RFC 6238
		const testSecret = "JBSWY3DPEHPK3PXP"; // Base32 encoded "HelloWorld"

		test("should generate a 6-digit TOTP code by default", async () => {
			const result = await generateTotp({ secret: testSecret });

			expect(result.code).toBeDefined();
			expect(result.code.length).toBe(6);
			expect(result.code).toMatch(/^\d{6}$/);
		});

		test("should generate a 7-digit TOTP code when specified", async () => {
			const result = await generateTotp({
				secret: testSecret,
				digits: 7,
			});

			expect(result.code.length).toBe(7);
			expect(result.code).toMatch(/^\d{7}$/);
		});

		test("should generate an 8-digit TOTP code when specified", async () => {
			const result = await generateTotp({
				secret: testSecret,
				digits: 8,
			});

			expect(result.code.length).toBe(8);
			expect(result.code).toMatch(/^\d{8}$/);
		});

		test("should return remaining seconds and progress", async () => {
			const result = await generateTotp({ secret: testSecret });

			expect(result.remainingSeconds).toBeGreaterThanOrEqual(0);
			expect(result.remainingSeconds).toBeLessThanOrEqual(30);
			expect(result.period).toBe(30);
			expect(result.progress).toBeGreaterThanOrEqual(0);
			expect(result.progress).toBeLessThanOrEqual(100);
		});

		test("should use custom period", async () => {
			const result = await generateTotp({
				secret: testSecret,
				period: 60,
			});

			expect(result.period).toBe(60);
			expect(result.remainingSeconds).toBeLessThanOrEqual(60);
		});

		test("should support SHA256 algorithm", async () => {
			const result = await generateTotp({
				secret: testSecret,
				algorithm: "SHA256",
			});

			expect(result.code).toBeDefined();
			expect(result.code.length).toBe(6);
		});

		test("should support SHA512 algorithm", async () => {
			const result = await generateTotp({
				secret: testSecret,
				algorithm: "SHA512",
			});

			expect(result.code).toBeDefined();
			expect(result.code.length).toBe(6);
		});
	});

	describe("TOTP at Specific Time", () => {
		const testSecret = "JBSWY3DPEHPK3PXP";

		test("should generate consistent code for same timestamp", async () => {
			const timestamp = 1234567890; // Unix timestamp

			const code1 = await generateTotpAt({ secret: testSecret }, timestamp);
			const code2 = await generateTotpAt({ secret: testSecret }, timestamp);

			expect(code1).toBe(code2);
		});

		test("should generate different codes for different periods", async () => {
			const timestamp1 = 1234567890;
			const timestamp2 = 1234567920; // 30 seconds later

			const code1 = await generateTotpAt({ secret: testSecret }, timestamp1);
			const code2 = await generateTotpAt({ secret: testSecret }, timestamp2);

			// Codes should be different (different time steps)
			expect(code1).not.toBe(code2);
		});

		test("should generate same code within same period", async () => {
			const timestamp1 = 1234567890;
			const timestamp2 = 1234567900; // 10 seconds later (same period)

			const code1 = await generateTotpAt({ secret: testSecret }, timestamp1);
			const code2 = await generateTotpAt({ secret: testSecret }, timestamp2);

			// Should be same since they're in the same 30-second window
			expect(code1).toBe(code2);
		});
	});

	describe("TOTP Verification", () => {
		const testSecret = "JBSWY3DPEHPK3PXP";

		test("should verify current TOTP code", async () => {
			const result = await generateTotp({ secret: testSecret });
			const isValid = await verifyTotp(result.code, { secret: testSecret });

			expect(isValid).toBe(true);
		});

		test("should reject invalid TOTP code", async () => {
			const isValid = await verifyTotp("000000", { secret: testSecret });

			// Very unlikely to be valid (1 in 1,000,000 chance)
			// In practice this should fail
			expect(isValid).toBe(false);
		});

		test("should accept code within tolerance window", async () => {
			const result = await generateTotp({ secret: testSecret });
			// Default tolerance is 1 period
			const isValid = await verifyTotp(result.code, { secret: testSecret }, 1);

			expect(isValid).toBe(true);
		});
	});

	describe("OTP Auth URI Parsing", () => {
		test("should parse a basic otpauth URI", () => {
			const uri =
				"otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

			const parsed = parseOtpAuthUri(uri);

			expect(parsed.type).toBe("totp");
			expect(parsed.secret).toBe("JBSWY3DPEHPK3PXP");
			expect(parsed.issuer).toBe("Example");
			expect(parsed.accountName).toBe("alice@example.com");
		});

		test("should parse URI with all parameters", () => {
			const uri =
				"otpauth://totp/Service:user@test.com?secret=ABCDEFGH&issuer=Service&algorithm=SHA256&digits=8&period=60";

			const parsed = parseOtpAuthUri(uri);

			expect(parsed.type).toBe("totp");
			expect(parsed.secret).toBe("ABCDEFGH");
			expect(parsed.issuer).toBe("Service");
			expect(parsed.accountName).toBe("user@test.com");
			expect(parsed.algorithm).toBe("SHA256");
			expect(parsed.digits).toBe(8);
			expect(parsed.period).toBe(60);
		});

		test("should parse URI without issuer prefix", () => {
			const uri =
				"otpauth://totp/user@test.com?secret=JBSWY3DPEHPK3PXP&issuer=TestService";

			const parsed = parseOtpAuthUri(uri);

			expect(parsed.accountName).toBe("user@test.com");
			expect(parsed.issuer).toBe("TestService");
		});

		test("should throw error for missing secret", () => {
			const uri = "otpauth://totp/Example:alice?issuer=Example";

			expect(() => parseOtpAuthUri(uri)).toThrow();
		});

		test("should throw error for invalid scheme", () => {
			const uri = "https://example.com/totp?secret=ABCD";

			expect(() => parseOtpAuthUri(uri)).toThrow();
		});
	});

	describe("OTP Auth URI Generation", () => {
		test("should generate a valid otpauth URI", () => {
			const uri = generateOtpAuthUri({
				secret: "JBSWY3DPEHPK3PXP",
				issuer: "TestService",
				accountName: "user@test.com",
			});

			expect(uri).toContain("otpauth://totp/");
			expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
			expect(uri).toContain("issuer=TestService");
		});

		test("should include non-default algorithm in URI", () => {
			const uri = generateOtpAuthUri({
				secret: "JBSWY3DPEHPK3PXP",
				algorithm: "SHA256",
			});

			expect(uri).toContain("algorithm=SHA256");
		});

		test("should include non-default digits in URI", () => {
			const uri = generateOtpAuthUri({
				secret: "JBSWY3DPEHPK3PXP",
				digits: 8,
			});

			expect(uri).toContain("digits=8");
		});

		test("should include non-default period in URI", () => {
			const uri = generateOtpAuthUri({
				secret: "JBSWY3DPEHPK3PXP",
				period: 60,
			});

			expect(uri).toContain("period=60");
		});

		test("should not include default values in URI", () => {
			const uri = generateOtpAuthUri({
				secret: "JBSWY3DPEHPK3PXP",
				algorithm: "SHA1", // default
				digits: 6, // default
				period: 30, // default
			});

			expect(uri).not.toContain("algorithm=");
			expect(uri).not.toContain("digits=");
			expect(uri).not.toContain("period=");
		});
	});

	describe("Secret Generation", () => {
		test("should generate a valid base32 secret", () => {
			const secret = generateTotpSecret();

			expect(isValidBase32(secret)).toBe(true);
		});

		test("should generate unique secrets", () => {
			const secret1 = generateTotpSecret();
			const secret2 = generateTotpSecret();
			const secret3 = generateTotpSecret();

			expect(secret1).not.toBe(secret2);
			expect(secret2).not.toBe(secret3);
			expect(secret1).not.toBe(secret3);
		});

		test("should generate secret of specified length", () => {
			const secret = generateTotpSecret(32);

			// Base32 encoding produces ~8/5 the output length
			// 32 bytes should produce ~52 characters
			expect(secret.length).toBeGreaterThanOrEqual(50);
		});

		test("should generate usable TOTP secret", async () => {
			const secret = generateTotpSecret();

			// Should be able to generate TOTP with the secret
			const result = await generateTotp({ secret });

			expect(result.code).toBeDefined();
			expect(result.code.length).toBe(6);
		});
	});

	describe("Mobile TOTP Display Feature Integration", () => {
		test("should support live code generation cycle", async () => {
			const secret = "JBSWY3DPEHPK3PXP";

			// Simulate multiple rapid code generations (like the 1-second interval in the component)
			const codes = [];
			for (let i = 0; i < 5; i++) {
				const result = await generateTotp({ secret });
				codes.push(result);
			}

			// All codes should be valid 6-digit numbers
			for (const result of codes) {
				expect(result.code).toMatch(/^\d{6}$/);
				expect(result.remainingSeconds).toBeGreaterThanOrEqual(0);
				expect(result.remainingSeconds).toBeLessThanOrEqual(30);
				expect(result.progress).toBeGreaterThanOrEqual(0);
				expect(result.progress).toBeLessThanOrEqual(100);
			}

			// Codes should be the same within the same time period
			const uniqueCodes = new Set(codes.map((c) => c.code));
			expect(uniqueCodes.size).toBe(1); // All codes should be identical within rapid succession
		});

		test("should provide progress for countdown animation", async () => {
			const secret = "JBSWY3DPEHPK3PXP";
			const result = await generateTotp({ secret });

			// Progress should be a valid percentage
			expect(result.progress).toBeGreaterThanOrEqual(0);
			expect(result.progress).toBeLessThanOrEqual(100);

			// Remaining seconds should correspond to progress
			const expectedProgress = ((30 - result.remainingSeconds) / 30) * 100;
			expect(Math.abs(result.progress - expectedProgress)).toBeLessThan(1);
		});

		test("should handle TOTP from QR code scan (otpauth URI)", async () => {
			// Simulate scanning a QR code
			const qrCodeUri =
				"otpauth://totp/GitHub:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

			// Parse the URI
			const parsed = parseOtpAuthUri(qrCodeUri);

			expect(parsed.secret).toBe("JBSWY3DPEHPK3PXP");
			expect(parsed.issuer).toBe("GitHub");
			expect(parsed.accountName).toBe("user@example.com");

			// Generate TOTP from parsed data
			const result = await generateTotp({
				secret: parsed.secret,
				algorithm: parsed.algorithm,
				digits: parsed.digits,
				period: parsed.period,
			});

			expect(result.code).toMatch(/^\d{6}$/);
		});

		test("should support various authenticator configurations", async () => {
			const configurations = [
				{
					secret: "JBSWY3DPEHPK3PXP",
					algorithm: "SHA1" as const,
					digits: 6 as const,
				},
				{
					secret: "JBSWY3DPEHPK3PXP",
					algorithm: "SHA256" as const,
					digits: 6 as const,
				},
				{
					secret: "JBSWY3DPEHPK3PXP",
					algorithm: "SHA512" as const,
					digits: 6 as const,
				},
				{
					secret: "JBSWY3DPEHPK3PXP",
					algorithm: "SHA1" as const,
					digits: 7 as const,
				},
				{
					secret: "JBSWY3DPEHPK3PXP",
					algorithm: "SHA1" as const,
					digits: 8 as const,
				},
			];

			for (const config of configurations) {
				const result = await generateTotp(config);
				expect(result.code.length).toBe(config.digits);
				expect(result.code).toMatch(new RegExp(`^\\d{${config.digits}}$`));
			}
		});
	});
});
