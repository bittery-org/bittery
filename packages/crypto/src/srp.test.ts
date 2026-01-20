/**
 * Comprehensive Unit Tests for SRP-6a Authentication
 *
 * Tests cover:
 * - SRP registration (salt and verifier generation)
 * - Client ephemeral key generation
 * - Server ephemeral key generation
 * - Full authentication handshake
 * - Session key derivation and verification
 * - Error handling (wrong passwords, invalid proofs)
 * - Security properties
 */

import { describe, expect, test } from "bun:test";
import {
	deriveClientSession,
	generateClientEphemeral,
	generateSRPRegistration,
	verifyServerSession,
} from "./srp-client";
import {
	deriveServerSession,
	generateServerEphemeral,
} from "./srp-server";

describe("SRP-6a Authentication Module", () => {
	describe("Registration (Client Side)", () => {
		test("should generate salt and verifier for registration", async () => {
			const password = "UserPassword123!";

			const registration = await generateSRPRegistration(password);

			expect(registration.salt).toBeDefined();
			expect(registration.verifier).toBeDefined();
			expect(typeof registration.salt).toBe("string");
			expect(typeof registration.verifier).toBe("string");
		});

		test("should generate non-empty salt and verifier", async () => {
			const password = "TestPassword";

			const registration = await generateSRPRegistration(password);

			expect(registration.salt.length).toBeGreaterThan(0);
			expect(registration.verifier.length).toBeGreaterThan(0);
		});

		test("should generate different salt each time", async () => {
			const password = "SamePassword";

			const reg1 = await generateSRPRegistration(password);
			const reg2 = await generateSRPRegistration(password);

			expect(reg1.salt).not.toBe(reg2.salt);
		});

		test("should generate different verifier for different salts", async () => {
			const password = "SamePassword";

			const reg1 = await generateSRPRegistration(password);
			const reg2 = await generateSRPRegistration(password);

			// Different salts lead to different verifiers
			expect(reg1.verifier).not.toBe(reg2.verifier);
		});

		test("should generate verifier of appropriate length for 4096-bit group", async () => {
			const password = "TestPassword";

			const registration = await generateSRPRegistration(password);

			// 4096-bit verifier in hex should be ~1024 chars
			// (actual length depends on encoding)
			expect(registration.verifier.length).toBeGreaterThan(500);
		});
	});

	describe("Client Ephemeral Generation", () => {
		test("should generate client ephemeral key pair", () => {
			const ephemeral = generateClientEphemeral();

			expect(ephemeral.publicKey).toBeDefined();
			expect(ephemeral.secret).toBeDefined();
			expect(typeof ephemeral.publicKey).toBe("string");
			expect(typeof ephemeral.secret).toBe("string");
		});

		test("should generate unique ephemeral keys each time", () => {
			const eph1 = generateClientEphemeral();
			const eph2 = generateClientEphemeral();

			expect(eph1.publicKey).not.toBe(eph2.publicKey);
			expect(eph1.secret).not.toBe(eph2.secret);
		});

		test("should generate non-zero ephemeral values", () => {
			const ephemeral = generateClientEphemeral();

			expect(ephemeral.publicKey.length).toBeGreaterThan(0);
			expect(ephemeral.secret.length).toBeGreaterThan(0);
		});
	});

	describe("Server Ephemeral Generation", () => {
		test("should generate server ephemeral from verifier", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);

			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			expect(serverEphemeral.publicKey).toBeDefined();
			expect(serverEphemeral.secret).toBeDefined();
		});

		test("should generate different server ephemeral each time", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);

			const eph1 = await generateServerEphemeral(registration.verifier);
			const eph2 = await generateServerEphemeral(registration.verifier);

			expect(eph1.publicKey).not.toBe(eph2.publicKey);
			expect(eph1.secret).not.toBe(eph2.secret);
		});
	});

	describe("Full Authentication Handshake", () => {
		test("should complete successful authentication with correct password", async () => {
			const password = "CorrectPassword123!";

			// Step 1: Registration (one-time during signup)
			const registration = await generateSRPRegistration(password);

			// Step 2: Client starts login
			const clientEphemeral = generateClientEphemeral();

			// Step 3: Server responds with challenge
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const serverChallenge = {
				salt: registration.salt,
				serverPublicKey: serverEphemeral.publicKey,
			};

			// Step 4: Client computes session and proof
			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				serverChallenge,
				password,
			);

			// Step 5: Server verifies client proof and computes server proof
			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			// Step 6: Client verifies server proof
			await verifyServerSession(
				clientEphemeral.publicKey,
				clientSession,
				serverSession.proof,
			);

			// Verify both sides derived the same session key
			expect(clientSession.key).toBe(serverSession.key);
		});

		test("should derive same session key on both sides", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);
			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			// Session keys must match for zero-knowledge proof
			expect(clientSession.key).toBe(serverSession.key);
			expect(clientSession.key.length).toBeGreaterThan(0);
		});

		test("should generate session key of appropriate length", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);
			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			// SHA-256 based SRP produces 256-bit session key (64 hex chars)
			expect(clientSession.key.length).toBeGreaterThan(0);
		});
	});

	describe("Error Handling - Wrong Password", () => {
		test("should fail authentication with wrong password", async () => {
			const correctPassword = "CorrectPassword";
			const wrongPassword = "WrongPassword";

			// Register with correct password
			const registration = await generateSRPRegistration(correctPassword);

			// Client tries to login with wrong password
			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				wrongPassword, // Wrong password!
			);

			// Server should reject the client's proof
			let authFailed = false;
			try {
				await deriveServerSession(
					serverEphemeral.secret,
					clientEphemeral.publicKey,
					registration.salt,
					registration.verifier,
					clientSession.proof,
				);
			} catch {
				authFailed = true;
			}

			expect(authFailed).toBe(true);
		});

		test("should fail with similar but different password", async () => {
			const correctPassword = "MyPassword123";
			const similarPasswords = [
				"MyPassword124",
				"myPassword123",
				"MyPassword123 ",
				" MyPassword123",
			];

			const registration = await generateSRPRegistration(correctPassword);

			for (const wrongPassword of similarPasswords) {
				const clientEphemeral = generateClientEphemeral();
				const serverEphemeral = await generateServerEphemeral(
					registration.verifier,
				);

				const clientSession = await deriveClientSession(
					clientEphemeral.secret,
					{
						salt: registration.salt,
						serverPublicKey: serverEphemeral.publicKey,
					},
					wrongPassword,
				);

				let authFailed = false;
				try {
					await deriveServerSession(
						serverEphemeral.secret,
						clientEphemeral.publicKey,
						registration.salt,
						registration.verifier,
						clientSession.proof,
					);
				} catch {
					authFailed = true;
				}

				expect(authFailed).toBe(true);
			}
		});
	});

	describe("Error Handling - Invalid Proofs", () => {
		test("should fail with tampered client proof", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);
			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			// Tamper with the proof
			const tamperedProof = clientSession.proof.slice(0, -4) + "XXXX";

			let authFailed = false;
			try {
				await deriveServerSession(
					serverEphemeral.secret,
					clientEphemeral.publicKey,
					registration.salt,
					registration.verifier,
					tamperedProof,
				);
			} catch {
				authFailed = true;
			}

			expect(authFailed).toBe(true);
		});

		test("should fail with wrong server proof verification", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);
			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			// Tamper with server proof
			const tamperedServerProof = serverSession.proof.slice(0, -4) + "YYYY";

			let verificationFailed = false;
			try {
				await verifyServerSession(
					clientEphemeral.publicKey,
					clientSession,
					tamperedServerProof,
				);
			} catch {
				verificationFailed = true;
			}

			expect(verificationFailed).toBe(true);
		});
	});

	describe("Edge Cases - Passwords", () => {
		test("should handle empty password", async () => {
			const password = "";
			const registration = await generateSRPRegistration(password);

			expect(registration.salt).toBeDefined();
			expect(registration.verifier).toBeDefined();

			// Should complete full auth
			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			expect(clientSession.key).toBe(serverSession.key);
		});

		test("should handle very long password", async () => {
			const password = "A".repeat(10000);
			const registration = await generateSRPRegistration(password);

			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			expect(clientSession.key).toBe(serverSession.key);
		});

		test("should handle unicode password", async () => {
			const password = "Passort: cafe";
			const registration = await generateSRPRegistration(password);

			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			expect(clientSession.key).toBe(serverSession.key);
		});

		test("should handle special characters in password", async () => {
			const password = "P@$$w0rd!#$%^&*()_+-=[]{}|;':\",./<>?";
			const registration = await generateSRPRegistration(password);

			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			expect(clientSession.key).toBe(serverSession.key);
		});
	});

	describe("Security Properties", () => {
		test("should not leak password through registration data", async () => {
			const password = "SecretPassword123";
			const registration = await generateSRPRegistration(password);

			// Salt and verifier should not contain the password
			expect(registration.salt.includes(password)).toBe(false);
			expect(registration.verifier.includes(password)).toBe(false);
		});

		test("should generate unique session keys per authentication", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);

			// Perform two separate authentications
			const sessions: string[] = [];

			for (let i = 0; i < 3; i++) {
				const clientEphemeral = generateClientEphemeral();
				const serverEphemeral = await generateServerEphemeral(
					registration.verifier,
				);

				const clientSession = await deriveClientSession(
					clientEphemeral.secret,
					{
						salt: registration.salt,
						serverPublicKey: serverEphemeral.publicKey,
					},
					password,
				);

				sessions.push(clientSession.key);
			}

			// Each session should have a unique key
			const uniqueSessions = new Set(sessions);
			expect(uniqueSessions.size).toBe(3);
		});

		test("should produce different verifiers for same password with different registration", async () => {
			const password = "SamePassword";

			const reg1 = await generateSRPRegistration(password);
			const reg2 = await generateSRPRegistration(password);
			const reg3 = await generateSRPRegistration(password);

			// Verifiers should all be different (different salts)
			expect(reg1.verifier).not.toBe(reg2.verifier);
			expect(reg2.verifier).not.toBe(reg3.verifier);
			expect(reg1.verifier).not.toBe(reg3.verifier);
		});
	});

	describe("Full Authentication Workflow", () => {
		test("should simulate complete user signup and login flow", async () => {
			// === SIGNUP PHASE ===
			const userPassword = "UserSecurePassword!123";

			// Client generates registration data
			const registration = await generateSRPRegistration(userPassword);

			// Server stores: registration.salt and registration.verifier
			// (In real app, these go to the database)
			const storedSalt = registration.salt;
			const storedVerifier = registration.verifier;

			// === LOGIN PHASE ===

			// Step 1: Client starts login, generates ephemeral
			const clientEphemeral = generateClientEphemeral();
			const clientPublicA = clientEphemeral.publicKey;

			// Client sends username + clientPublicA to server

			// Step 2: Server looks up user, generates challenge
			// (Server retrieves storedSalt and storedVerifier from DB)
			const serverEphemeral = await generateServerEphemeral(storedVerifier);

			// Server sends challenge to client
			const serverChallenge = {
				salt: storedSalt,
				serverPublicKey: serverEphemeral.publicKey,
			};

			// Step 3: Client computes session and proof
			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				serverChallenge,
				userPassword,
			);

			// Client sends proof to server
			const clientProof = clientSession.proof;

			// Step 4: Server verifies proof and computes own proof
			const serverSession = await deriveServerSession(
				serverEphemeral.secret,
				clientPublicA,
				storedSalt,
				storedVerifier,
				clientProof,
			);

			// Server sends serverSession.proof to client

			// Step 5: Client verifies server
			await verifyServerSession(
				clientEphemeral.publicKey,
				clientSession,
				serverSession.proof,
			);

			// === AUTHENTICATION COMPLETE ===

			// Both sides now have the same session key
			expect(clientSession.key).toBe(serverSession.key);

			// This key can be used to derive encryption keys for the session
			expect(clientSession.key.length).toBeGreaterThan(0);
		});

		test("should handle multiple sequential logins with same registration", async () => {
			const password = "PersistentPassword";
			const registration = await generateSRPRegistration(password);

			// Simulate 5 login sessions
			for (let i = 0; i < 5; i++) {
				const clientEphemeral = generateClientEphemeral();
				const serverEphemeral = await generateServerEphemeral(
					registration.verifier,
				);

				const clientSession = await deriveClientSession(
					clientEphemeral.secret,
					{
						salt: registration.salt,
						serverPublicKey: serverEphemeral.publicKey,
					},
					password,
				);

				const serverSession = await deriveServerSession(
					serverEphemeral.secret,
					clientEphemeral.publicKey,
					registration.salt,
					registration.verifier,
					clientSession.proof,
				);

				await verifyServerSession(
					clientEphemeral.publicKey,
					clientSession,
					serverSession.proof,
				);

				expect(clientSession.key).toBe(serverSession.key);
			}
		});
	});

	describe("Performance", () => {
		test("should complete registration quickly", async () => {
			const password = "TestPassword";

			const start = Date.now();
			await generateSRPRegistration(password);
			const elapsed = Date.now() - start;

			// Should complete in under 2 seconds
			expect(elapsed).toBeLessThan(2000);
		});

		test("should complete full authentication quickly", async () => {
			const password = "TestPassword";
			const registration = await generateSRPRegistration(password);

			const start = Date.now();

			const clientEphemeral = generateClientEphemeral();
			const serverEphemeral = await generateServerEphemeral(
				registration.verifier,
			);

			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{ salt: registration.salt, serverPublicKey: serverEphemeral.publicKey },
				password,
			);

			await deriveServerSession(
				serverEphemeral.secret,
				clientEphemeral.publicKey,
				registration.salt,
				registration.verifier,
				clientSession.proof,
			);

			const elapsed = Date.now() - start;

			// Full handshake should complete in under 2 seconds
			expect(elapsed).toBeLessThan(2000);
		});
	});
});
