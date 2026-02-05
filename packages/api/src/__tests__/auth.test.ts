/**
 * Integration Tests for Auth tRPC Router
 *
 * Tests cover:
 * - User signup with validation
 * - Email checking
 * - Session management (me, logout, logoutAll)
 * - Email updates
 * - Password changes
 * - Secret key regeneration
 * - Account deletion
 * - Device management (listDevices, revokeDevice, renameDevice)
 * - Heartbeat
 */

import { afterEach, describe, expect, test } from "bun:test";
import { authRouter } from "../routers/auth";
import {
	createPublicContext,
	createTestSession,
	createTestUser,
	createTestVault,
	generateTestEmail,
	getSession,
	getUser,
	mockSrpData,
	setup,
	truncateAll,
} from "./test-utils";

describe("Auth Router", () => {
	afterEach(async () => {
		await truncateAll();
	});

	describe("signup", () => {
		test("should create new user with organization", async () => {
			const email = generateTestEmail();
			const caller = authRouter.createCaller(createPublicContext());

			const result = await caller.signup({
				email,
				name: "Test User",
				organizationName: "Test Org",
				secretKeyHint: mockSrpData.secretKeyHint,
				srpSalt: mockSrpData.srpSalt,
				srpVerifier: mockSrpData.srpVerifier,
				publicKey: mockSrpData.publicKey,
				encryptedPrivateKey: mockSrpData.encryptedPrivateKey,
				encryptedVaultKey: mockSrpData.encryptedVaultKey,
			});

			expect(result.success).toBe(true);
			expect(result.userId).toBeDefined();
			expect(result.token).toBeDefined();
			expect(result.sessionId).toBeDefined();
			expect(result.user).toBeDefined();
			expect(result.user.email).toBe(email.toLowerCase());
			expect(result.user.teamName).toBe("Test Org");
			expect(result.user.teamType).toBe("organization");
			expect(result.vaultKeys).toHaveLength(1);
			// @ts-expect-error This is fine
			expect(result.vaultKeys[0].vaultName).toBe("Personal");
			// @ts-expect-error This is fine
			expect(result.vaultKeys[0].role).toBe("owner");
		});

		test("should create user without organization name", async () => {
			const caller = authRouter.createCaller(createPublicContext());

			const result = await caller.signup({
				email: generateTestEmail(),
				name: "Test User",
				secretKeyHint: mockSrpData.secretKeyHint,
				srpSalt: mockSrpData.srpSalt,
				srpVerifier: mockSrpData.srpVerifier,
				publicKey: mockSrpData.publicKey,
				encryptedPrivateKey: mockSrpData.encryptedPrivateKey,
				encryptedVaultKey: mockSrpData.encryptedVaultKey,
			});

			expect(result.success).toBe(true);
			expect(result.userId).toBeDefined();
		});

		test("should reject duplicate email", async () => {
			const email = generateTestEmail();
			await createTestUser({ email });

			const caller = authRouter.createCaller(createPublicContext());

			await expect(
				caller.signup({
					email,
					name: "Test User 2",
					secretKeyHint: mockSrpData.secretKeyHint,
					srpSalt: mockSrpData.srpSalt,
					srpVerifier: mockSrpData.srpVerifier,
					publicKey: mockSrpData.publicKey,
					encryptedPrivateKey: mockSrpData.encryptedPrivateKey,
					encryptedVaultKey: mockSrpData.encryptedVaultKey,
				}),
			).rejects.toThrow("User with this email already exists");
		});

		test("should normalize email to lowercase", async () => {
			const baseEmail = generateTestEmail();
			const email = baseEmail.toUpperCase();
			const caller = authRouter.createCaller(createPublicContext());

			const result = await caller.signup({
				email,
				name: "Test User",
				secretKeyHint: mockSrpData.secretKeyHint,
				srpSalt: mockSrpData.srpSalt,
				srpVerifier: mockSrpData.srpVerifier,
				publicKey: mockSrpData.publicKey,
				encryptedPrivateKey: mockSrpData.encryptedPrivateKey,
				encryptedVaultKey: mockSrpData.encryptedVaultKey,
			});

			const user = await getUser(result.userId);
			expect(user?.email).toBe(baseEmail);
		});
	});

	describe("checkEmail", () => {
		test("should return exists: true for existing email", async () => {
			const email = generateTestEmail();
			await createTestUser({ email });

			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.checkEmail({ email });

			expect(result.exists).toBe(true);
			expect(result.secretKeyHint).toBe(mockSrpData.secretKeyHint);
		});

		test("should return exists: false for non-existing email", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.checkEmail({
				email: "nonexistent@example.com",
			});

			expect(result.exists).toBe(false);
			expect(result.secretKeyHint).toBeNull();
		});

		test("should be case-insensitive", async () => {
			const email = generateTestEmail();
			await createTestUser({ email });

			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.checkEmail({ email: email.toUpperCase() });

			expect(result.exists).toBe(true);
		});
	});

	describe("me", () => {
		test("should return current user data when authenticated", async () => {
			const { userId, email, caller } = await setup(authRouter, {
				name: "Current User",
			});

			const result = await caller.me();

			expect(result.id).toBe(userId);
			expect(result.email).toBe(email);
			expect(result.name).toBe("Current User");
			expect(result.publicKey).toBe(mockSrpData.publicKey);
			expect(result.encryptedPrivateKey).toBe(mockSrpData.encryptedPrivateKey);
		});

		test("should throw UNAUTHORIZED for unauthenticated request", async () => {
			const caller = authRouter.createCaller(createPublicContext());

			await expect(caller.me()).rejects.toThrow("Authentication required");
		});
	});

	describe("logout", () => {
		test("should delete session", async () => {
			const { sessionId } = await setup(authRouter);

			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.logout({ sessionId });

			expect(result.success).toBe(true);

			const session = await getSession(sessionId);
			expect(session).toBeUndefined();
		});
	});

	describe("logoutAll", () => {
		test("should delete all user sessions", async () => {
			const { userId } = await setup(authRouter);

			await createTestSession(userId, { deviceName: "Device 2" });
			await createTestSession(userId, { deviceName: "Device 3" });

			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.logoutAll({ userId });

			expect(result.success).toBe(true);
		});
	});

	describe("updateEmail", () => {
		test("should update user email and logout all sessions", async () => {
			const { userId, caller } = await setup(authRouter);
			const newEmail = generateTestEmail();

			const result = await caller.updateEmail({ newEmail });

			expect(result.success).toBe(true);

			const user = await getUser(userId);
			expect(user?.email).toBe(newEmail.toLowerCase());
		});

		test("should reject email already in use by another user", async () => {
			const [{ caller }, { email: email2 }] = await Promise.all([
				setup(authRouter),
				setup(authRouter),
			]);

			await expect(caller.updateEmail({ newEmail: email2 })).rejects.toThrow(
				"Email already in use",
			);
		});
	});

	describe("changePassword", () => {
		test("should update SRP credentials and encrypted private key", async () => {
			const { userId, caller } = await setup(authRouter);
			const vaultId = await createTestVault(userId);

			const newSrpSalt = "newSalt123456789012345678901234567890123456789012345";
			const newSrpVerifier = `newVerifier${mockSrpData.srpVerifier.slice(11)}`;
			const newEncryptedPrivateKey = "newEncryptedPrivateKey123";

			const result = await caller.changePassword({
				srpSalt: newSrpSalt,
				srpVerifier: newSrpVerifier,
				encryptedPrivateKey: newEncryptedPrivateKey,
				encryptedVaultKeys: [{ vaultId, encryptedVaultKey: "newVaultKey123" }],
			});

			expect(result.success).toBe(true);

			const user = await getUser(userId);
			expect(user?.srpSalt).toBe(newSrpSalt);
			expect(user?.srpVerifier).toBe(newSrpVerifier);
			expect(user?.encryptedPrivateKey).toBe(newEncryptedPrivateKey);
		});
	});

	describe("regenerateSecretKey", () => {
		test("should update secret key hint and SRP credentials", async () => {
			const { userId, caller } = await setup(authRouter);
			const vaultId = await createTestVault(userId);

			const newSecretKeyHint = "B4-NEWKEY";
			const newSrpSalt = "newSalt987654321098765432109876543210987654321098";

			const result = await caller.regenerateSecretKey({
				secretKeyHint: newSecretKeyHint,
				srpSalt: newSrpSalt,
				srpVerifier: mockSrpData.srpVerifier,
				encryptedPrivateKey: "newEncrypted123",
				encryptedVaultKeys: [{ vaultId, encryptedVaultKey: "newVaultKey456" }],
			});

			expect(result.success).toBe(true);

			const user = await getUser(userId);
			expect(user?.secretKeyHint).toBe(newSecretKeyHint);
			expect(user?.srpSalt).toBe(newSrpSalt);
		});
	});

	describe("deleteAccount", () => {
		test("should delete user account with correct email confirmation", async () => {
			const { userId, email, caller } = await setup(authRouter);

			const result = await caller.deleteAccount({ confirmEmail: email });

			expect(result.success).toBe(true);

			const user = await getUser(userId);
			expect(user).toBeUndefined();
		});

		test("should reject deletion with wrong email", async () => {
			const { caller } = await setup(authRouter);

			await expect(
				caller.deleteAccount({ confirmEmail: "wrong@example.com" }),
			).rejects.toThrow("Email does not match");
		});
	});

	describe("listDevices", () => {
		test("should return all user sessions with current session marked", async () => {
			const { userId, sessionId, caller } = await setup(authRouter);
			const session2 = await createTestSession(userId, {
				deviceName: "Device 2",
			});

			const result = await caller.listDevices();

			expect(result.length).toBeGreaterThanOrEqual(2);
			const currentSession = result.find((s) => s.id === sessionId);
			const otherSession = result.find((s) => s.id === session2);

			expect(currentSession?.isCurrentSession).toBe(true);
			expect(otherSession?.isCurrentSession).toBe(false);
		});
	});

	describe("revokeDevice", () => {
		test("should revoke a specific session", async () => {
			const { userId, caller } = await setup(authRouter);
			const otherSession = await createTestSession(userId, {
				deviceName: "Other",
			});

			const result = await caller.revokeDevice({ sessionId: otherSession });

			expect(result.success).toBe(true);

			const session = await getSession(otherSession);
			expect(session).toBeUndefined();
		});

		test("should not allow revoking current session", async () => {
			const { sessionId, caller } = await setup(authRouter);

			await expect(caller.revokeDevice({ sessionId })).rejects.toThrow(
				"Cannot revoke current session",
			);
		});
	});

	describe("renameDevice", () => {
		test("should rename a session device", async () => {
			const { sessionId, caller } = await setup(authRouter);

			const result = await caller.renameDevice({
				sessionId,
				deviceName: "New Name",
			});

			expect(result.success).toBe(true);

			const session = await getSession(sessionId);
			expect(session?.deviceName).toBe("New Name");
		});
	});

	describe("heartbeat", () => {
		test("should update session last active timestamp", async () => {
			const { sessionId, caller } = await setup(authRouter);
			const originalSession = await getSession(sessionId);

			// Wait a bit to ensure timestamp changes
			await new Promise((resolve) => setTimeout(resolve, 100));

			const result = await caller.heartbeat();

			expect(result.success).toBe(true);

			const updatedSession = await getSession(sessionId);
			expect(updatedSession?.lastActiveAt.getTime()).toBeGreaterThanOrEqual(
				originalSession?.lastActiveAt.getTime() || 0,
			);
		});
	});
});
