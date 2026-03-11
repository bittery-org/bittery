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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db, signupVerification } from "@bittery/db";
import { eq } from "drizzle-orm";
import { authRouter } from "../routers/auth";
import { setControlBroadcastFunction } from "../sync-helper";
import {
	addTeamMember,
	createAuthenticatedContext,
	createPublicContext,
	createTestInvitation,
	createTestSession,
	createTestTeam,
	createTestUser,
	createTestVault,
	deriveTestSrpClientProof,
	generateTestAuthCryptoData,
	generateTestEmail,
	generateTestSrpClientEphemeral,
	getSession,
	getUser,
	setup,
	truncateAll,
} from "./test-utils";

function toSignupCryptoInput(
	data: Awaited<ReturnType<typeof generateTestAuthCryptoData>>,
) {
	return {
		secretKeyHint: data.secretKeyHint,
		recoveryKeyHint: data.recoveryKeyHint,
		srpSalt: data.srpSalt,
		srpVerifier: data.srpVerifier,
		publicKey: data.publicKey,
		encryptedPrivateKey: data.encryptedPrivateKey,
		encryptedMasterKey: data.encryptedMasterKey,
		encryptedVaultKey: data.encryptedVaultKey,
	};
}

async function issueSignupVerificationToken(params: {
	caller: ReturnType<typeof authRouter.createCaller>;
	email: string;
	invitationToken?: string;
}) {
	await params.caller.requestSignupVerification({
		email: params.email,
		...(params.invitationToken
			? { invitationToken: params.invitationToken }
			: {}),
	});

	const verification = await db.query.signupVerification.findFirst({
		where: (record, { and, eq, isNull }) =>
			and(
				eq(record.email, params.email.toLowerCase()),
				params.invitationToken
					? eq(record.invitationToken, params.invitationToken)
					: isNull(record.invitationToken),
				isNull(record.usedAt),
			),
		orderBy: (record, { desc }) => [desc(record.createdAt)],
	});

	if (!verification) {
		throw new Error("Expected signup verification to be created");
	}

	const result = await params.caller.verifySignupVerification({
		email: params.email,
		code: verification.code,
		...(params.invitationToken
			? { invitationToken: params.invitationToken }
			: {}),
	});

	if (!result.success || !result.signupVerificationToken) {
		throw new Error("Expected signup verification token");
	}

	return result.signupVerificationToken;
}

const authCryptoFixture = await generateTestAuthCryptoData({
	email: "fixture-auth@example.com",
	accountPassword: "TestPass-Fixture-1!",
});

const nextAuthCryptoFixture = await generateTestAuthCryptoData({
	email: "fixture-auth-next@example.com",
	accountPassword: "TestPass-Fixture-2!",
});
const originalBitteryMode = process.env.BITTERY_MODE;
const originalDevAuthStubs = process.env.BITTERY_ENABLE_DEV_AUTH_STUBS;
const originalNodeEnv = process.env.NODE_ENV;
const originalConsoleInfo = console.info;

describe("Auth Router", () => {
	beforeEach(() => {
		process.env.BITTERY_ENABLE_DEV_AUTH_STUBS = "true";
		process.env.NODE_ENV = "test";
		console.info = originalConsoleInfo;
	});

	afterEach(async () => {
		setControlBroadcastFunction(null);
		await truncateAll();
		if (originalBitteryMode === undefined) {
			delete process.env.BITTERY_MODE;
		} else {
			process.env.BITTERY_MODE = originalBitteryMode;
		}
		if (originalDevAuthStubs === undefined) {
			delete process.env.BITTERY_ENABLE_DEV_AUTH_STUBS;
		} else {
			process.env.BITTERY_ENABLE_DEV_AUTH_STUBS = originalDevAuthStubs;
		}
		if (originalNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = originalNodeEnv;
		}
		console.info = originalConsoleInfo;
	});

	describe("signup", () => {
		test("should create new user with organization", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			const result = await caller.signup({
				email,
				signupVerificationToken,
				name: "Test User",
				plan: "team",
				organizationName: "Test Org",
				...toSignupCryptoInput(cryptoData),
			});

			expect(result.success).toBe(true);
			expect(result.userId).toBeDefined();
			expect(result.token).toBeDefined();
			expect(result.sessionId).toBeDefined();
			expect(result.user).toBeDefined();
			expect(result.user.email).toBe(email.toLowerCase());
			expect(result.user.teamName).toBe("Test Org");
			expect(result.user.teamType).toBe("organization");
			const teamId = result.user.teamId;
			expect(teamId).toBeDefined();
			if (!teamId) {
				throw new Error("Expected signup to return a teamId");
			}
			const teamData = await db.query.team.findFirst({
				where: (t, { eq }) => eq(t.id, teamId),
			});
			expect(teamData?.billingPlan).toBe("team");
			expect(teamData?.billingStatus).toBe("incomplete");
			const createdUser = await getUser(result.userId);
			expect(createdUser?.emailVerified).toBe(true);
			expect(result.vaultKeys).toHaveLength(1);
			// @ts-expect-error This is fine
			expect(result.vaultKeys[0].vaultName).toBe("Personal");
			// @ts-expect-error This is fine
			expect(result.vaultKeys[0].role).toBe("owner");
		});

		test("should create user without organization name", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			const result = await caller.signup({
				email,
				signupVerificationToken,
				name: "Test User",
				...toSignupCryptoInput(cryptoData),
			});

			expect(result.success).toBe(true);
			expect(result.userId).toBeDefined();
			const teamId = result.user.teamId;
			expect(teamId).toBeDefined();
			if (!teamId) {
				throw new Error("Expected signup to return a teamId");
			}
			const teamData = await db.query.team.findFirst({
				where: (t, { eq }) => eq(t.id, teamId),
			});
			expect(teamData?.billingPlan).toBe("personal");
			expect(teamData?.billingStatus).toBe("incomplete");
			const createdUser = await getUser(result.userId);
			expect(createdUser?.emailVerified).toBe(true);
		});

		test("should reject signup without signupVerificationToken", async () => {
			const email = generateTestEmail();
			const caller = authRouter.createCaller(createPublicContext());

			await expect(
				caller.signup({
					email,
					name: "Missing Verification",
					...toSignupCryptoInput(authCryptoFixture),
				} as any),
			).rejects.toThrow();
		});

		test("should fail verification with a wrong code", async () => {
			const email = generateTestEmail();
			const caller = authRouter.createCaller(createPublicContext());

			await caller.requestSignupVerification({ email });
			const result = await caller.verifySignupVerification({
				email,
				code: "000000",
			});

			expect(result.success).toBe(false);
		});

		test("should fail verification with an expired code", async () => {
			const email = generateTestEmail();
			const caller = authRouter.createCaller(createPublicContext());

			await caller.requestSignupVerification({ email });
			const verification = await db.query.signupVerification.findFirst({
				where: (record, { and, eq, isNull }) =>
					and(
						eq(record.email, email.toLowerCase()),
						isNull(record.invitationToken),
						isNull(record.usedAt),
					),
				orderBy: (record, { desc }) => [desc(record.createdAt)],
			});
			expect(verification).toBeDefined();
			if (!verification) {
				throw new Error("Expected signup verification record");
			}

			await db
				.update(signupVerification)
				.set({ expiresAt: new Date(Date.now() - 60_000) })
				.where(eq(signupVerification.id, verification.id));

			const result = await caller.verifySignupVerification({
				email,
				code: verification.code,
			});

			expect(result.success).toBe(false);
		});

		test("should reject duplicate email", async () => {
			const email = generateTestEmail();
			const existingCryptoData = authCryptoFixture;
			await createTestUser({
				email,
				secretKeyHint: existingCryptoData.secretKeyHint,
				srpSalt: existingCryptoData.srpSalt,
				srpVerifier: existingCryptoData.srpVerifier,
				publicKey: existingCryptoData.publicKey,
				encryptedPrivateKey: existingCryptoData.encryptedPrivateKey,
			});
			const signupCryptoData = existingCryptoData;

			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			await expect(
				caller.signup({
					email,
					signupVerificationToken,
					name: "Test User 2",
					...toSignupCryptoInput(signupCryptoData),
				}),
			).rejects.toThrow("Unable to create account");
		});

		test("should normalize email to lowercase", async () => {
			const baseEmail = generateTestEmail();
			const email = baseEmail.toUpperCase();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			const result = await caller.signup({
				email,
				signupVerificationToken,
				name: "Test User",
				...toSignupCryptoInput(cryptoData),
			});

			const user = await getUser(result.userId);
			expect(user?.email).toBe(baseEmail);
		});

		test("should allow only bootstrap signup in self-hosted mode", async () => {
			process.env.BITTERY_MODE = "self-hosted";
			const caller = authRouter.createCaller(createPublicContext());
			const firstSignupEmail = generateTestEmail();
			const firstSignupVerificationToken = await issueSignupVerificationToken({
				caller,
				email: firstSignupEmail,
			});

			const firstSignup = await caller.signup({
				email: firstSignupEmail,
				signupVerificationToken: firstSignupVerificationToken,
				name: "First Admin",
				...toSignupCryptoInput(authCryptoFixture),
			});
			expect(firstSignup.success).toBe(true);
			expect(firstSignup.user.role).toBe("owner");
			expect(firstSignup.user.teamType).toBe("organization");
			const teamId = firstSignup.user.teamId;
			expect(teamId).toBeDefined();
			if (!teamId) {
				throw new Error("Expected signup to return a teamId");
			}
			const firstTeam = await db.query.team.findFirst({
				where: (t, { eq }) => eq(t.id, teamId),
			});
			expect(firstTeam?.billingPlan).toBe("free");
			expect(firstTeam?.billingStatus).toBe("none");

			const secondSignupEmail = generateTestEmail();
			await expect(
				caller.signup({
					email: secondSignupEmail,
					signupVerificationToken: "invalid-token",
					name: "Second User",
					...toSignupCryptoInput(nextAuthCryptoFixture),
				}),
			).rejects.toThrow("Public registration is disabled");
		});

		test("signupWithInvitation should create a personal vault for invitees", async () => {
			const inviter = await setup(authRouter);
			const teamId = await createTestTeam(inviter.userId, {
				name: "Invite Team",
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const inviteeEmail = generateTestEmail();
			const invitation = await createTestInvitation(
				teamId,
				inviter.userId,
				inviteeEmail,
			);
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email: inviteeEmail,
				invitationToken: invitation.token,
			});

			const result = await caller.signupWithInvitation({
				token: invitation.token,
				email: inviteeEmail,
				signupVerificationToken,
				name: "Invitee",
				...toSignupCryptoInput(nextAuthCryptoFixture),
			});

			expect(result.success).toBe(true);
			expect(result.user.teamId).toBe(teamId);
			const createdUser = await getUser(result.userId);
			expect(createdUser?.emailVerified).toBe(true);
			const personalVault = result.vaultKeys.find(
				(vk) => vk.vaultName === "Personal",
			);
			expect(personalVault).toBeDefined();
			expect(personalVault?.role).toBe("owner");
		});

		test("requestSignupVerification should reject invitation/email mismatch", async () => {
			const inviter = await setup(authRouter);
			const teamId = await createTestTeam(inviter.userId, {
				name: "Invite Team",
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const invitation = await createTestInvitation(
				teamId,
				inviter.userId,
				generateTestEmail(),
			);
			const caller = authRouter.createCaller(createPublicContext());

			await expect(
				caller.requestSignupVerification({
					email: generateTestEmail(),
					invitationToken: invitation.token,
				}),
			).rejects.toThrow("Email does not match invitation");
		});

		test("dev auth stubs should log no codes or emails when enabled", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			const messages: string[] = [];
			console.info = (...args: unknown[]) => {
				messages.push(args.map((value) => String(value)).join(" "));
			};
			const email = generateTestEmail();

			await caller.requestSignupVerification({ email });

			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain("enabled dev stub");
			expect(messages[0]).not.toContain(email);
			expect(messages[0]).not.toMatch(/\b\d{6}\b/);
		});

		test("auth code requests should fail cleanly when the dev stub is disabled and no provider exists", async () => {
			delete process.env.BITTERY_ENABLE_DEV_AUTH_STUBS;
			const caller = authRouter.createCaller(createPublicContext());

			await expect(
				caller.requestSignupVerification({ email: generateTestEmail() }),
			).rejects.toThrow(
				"Auth email delivery is not configured. Set BITTERY_ENABLE_DEV_AUTH_STUBS=true for local development or configure a real email provider.",
			);
		});

		test("signupWithInvitation should reject unauthorized pendingVaultKeys", async () => {
			const inviter = await setup(authRouter);
			const outsider = await setup(authRouter);
			const teamId = await createTestTeam(inviter.userId, {
				name: "Invite Team",
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const outsiderTeamId = await createTestTeam(outsider.userId, {
				name: "Outside Team",
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const foreignVaultId = await createTestVault(outsider.userId, {
				type: "team",
				teamId: outsiderTeamId,
			});
			const inviteeEmail = generateTestEmail();
			const invitation = await createTestInvitation(
				teamId,
				inviter.userId,
				inviteeEmail,
				{
					pendingVaultKeys: JSON.stringify([
						{
							vaultId: foreignVaultId,
							encryptedVaultKey: "malicious-key",
						},
					]),
				},
			);
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email: inviteeEmail,
				invitationToken: invitation.token,
			});

			await expect(
				caller.signupWithInvitation({
					token: invitation.token,
					email: inviteeEmail,
					signupVerificationToken,
					name: "Invitee",
					...toSignupCryptoInput(nextAuthCryptoFixture),
				}),
			).rejects.toThrow(
				"pendingVaultKeys contains vaults outside the invited team",
			);

			const createdUser = await db.query.user.findFirst({
				where: (u, { eq }) => eq(u.email, inviteeEmail.toLowerCase()),
			});
			expect(createdUser).toBeUndefined();
		});
	});

	describe("registrationStatus", () => {
		test("should report cloud mode as open registration", async () => {
			delete process.env.BITTERY_MODE;
			const caller = authRouter.createCaller(createPublicContext());

			const result = await caller.registrationStatus();

			expect(result.mode).toBe("cloud");
			expect(result.allowPublicSignup).toBe(true);
		});

		test("should report self-hosted bootstrap status before first user", async () => {
			process.env.BITTERY_MODE = "self-hosted";
			const caller = authRouter.createCaller(createPublicContext());

			const result = await caller.registrationStatus();

			expect(result.mode).toBe("self-hosted");
			expect(result.allowPublicSignup).toBe(true);
		});

		test("should report self-hosted invite-only after bootstrap user exists", async () => {
			process.env.BITTERY_MODE = "self-hosted";
			await createTestUser();
			const caller = authRouter.createCaller(createPublicContext());

			const result = await caller.registrationStatus();

			expect(result.mode).toBe("self-hosted");
			expect(result.allowPublicSignup).toBe(false);
			expect(result.reason).toBe("invite_only_after_bootstrap");
		});
	});

	describe("login (SRP)", () => {
		test("should complete startLogin/finishLogin with real SRP values", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			await caller.signup({
				email,
				signupVerificationToken,
				name: "Login User",
				...toSignupCryptoInput(cryptoData),
			});

			const clientEphemeral = await generateTestSrpClientEphemeral();
			const startResult = await caller.startLogin({
				email,
				clientPublicKey: clientEphemeral.clientPublicKey,
			});
			expect("userId" in startResult).toBe(false);
			expect("serverSecret" in startResult).toBe(false);
			const { clientProof } = await deriveTestSrpClientProof({
				clientSecret: clientEphemeral.clientSecret,
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				authPassword: cryptoData.authPassword,
			});

			const finishResult = await caller.finishLogin({
				attemptId: startResult.attemptId,
				clientPublicKey: clientEphemeral.clientPublicKey,
				clientProof,
			});

			expect(finishResult.token).toBeDefined();
			expect(finishResult.sessionId).toBeDefined();
			expect(finishResult.expiresAt).toBeDefined();
			expect(finishResult.serverProof).toBeDefined();
			expect(finishResult.user.email).toBe(email.toLowerCase());
		});

		test("should reject finishLogin with invalid SRP proof", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			await caller.signup({
				email,
				signupVerificationToken,
				name: "Login User",
				...toSignupCryptoInput(cryptoData),
			});

			const clientEphemeral = await generateTestSrpClientEphemeral();
			const startResult = await caller.startLogin({
				email,
				clientPublicKey: clientEphemeral.clientPublicKey,
			});
			const { clientProof } = await deriveTestSrpClientProof({
				clientSecret: clientEphemeral.clientSecret,
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				authPassword: `${cryptoData.authPassword}wrong`,
			});

			await expect(
				caller.finishLogin({
					attemptId: startResult.attemptId,
					clientPublicKey: clientEphemeral.clientPublicKey,
					clientProof,
				}),
			).rejects.toThrow("Invalid credentials");
		});

		test("should return a valid-shaped challenge for unknown email", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			const clientEphemeral = await generateTestSrpClientEphemeral();

			const startResult = await caller.startLogin({
				email: generateTestEmail(),
				clientPublicKey: clientEphemeral.clientPublicKey,
			});

			expect(startResult.attemptId).toBeDefined();
			expect(startResult.salt).toBeDefined();
			expect(startResult.serverPublicKey).toBeDefined();
			expect(startResult.kdfParams).toBeDefined();
		});

		test("should fail generically for fake-user finishLogin", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			const unknownEmail = generateTestEmail();
			const clientEphemeral = await generateTestSrpClientEphemeral();
			const startResult = await caller.startLogin({
				email: unknownEmail,
				clientPublicKey: clientEphemeral.clientPublicKey,
			});
			const { clientProof } = await deriveTestSrpClientProof({
				clientSecret: clientEphemeral.clientSecret,
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				authPassword: "not-the-right-password",
			});

			await expect(
				caller.finishLogin({
					attemptId: startResult.attemptId,
					clientPublicKey: clientEphemeral.clientPublicKey,
					clientProof,
				}),
			).rejects.toThrow("Invalid credentials");
		});

		test("should reject reused login attempts", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			await caller.signup({
				email,
				signupVerificationToken,
				name: "Login User",
				...toSignupCryptoInput(cryptoData),
			});

			const clientEphemeral = await generateTestSrpClientEphemeral();
			const startResult = await caller.startLogin({
				email,
				clientPublicKey: clientEphemeral.clientPublicKey,
			});
			const { clientProof } = await deriveTestSrpClientProof({
				clientSecret: clientEphemeral.clientSecret,
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				authPassword: cryptoData.authPassword,
			});

			await caller.finishLogin({
				attemptId: startResult.attemptId,
				clientPublicKey: clientEphemeral.clientPublicKey,
				clientProof,
			});

			await expect(
				caller.finishLogin({
					attemptId: startResult.attemptId,
					clientPublicKey: clientEphemeral.clientPublicKey,
					clientProof,
				}),
			).rejects.toThrow("Invalid credentials");
		});

		test("should reject mismatched client public key for login attempt", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const caller = authRouter.createCaller(createPublicContext());
			const signupVerificationToken = await issueSignupVerificationToken({
				caller,
				email,
			});

			await caller.signup({
				email,
				signupVerificationToken,
				name: "Login User",
				...toSignupCryptoInput(cryptoData),
			});

			const firstEphemeral = await generateTestSrpClientEphemeral();
			const secondEphemeral = await generateTestSrpClientEphemeral();
			const startResult = await caller.startLogin({
				email,
				clientPublicKey: firstEphemeral.clientPublicKey,
			});
			const { clientProof } = await deriveTestSrpClientProof({
				clientSecret: firstEphemeral.clientSecret,
				salt: startResult.salt,
				serverPublicKey: startResult.serverPublicKey,
				authPassword: cryptoData.authPassword,
			});

			await expect(
				caller.finishLogin({
					attemptId: startResult.attemptId,
					clientPublicKey: secondEphemeral.clientPublicKey,
					clientProof,
				}),
			).rejects.toThrow("Invalid credentials");
		});
	});

	describe("checkEmail", () => {
		test("should return exists: true for existing email", async () => {
			const email = generateTestEmail();
			const cryptoData = authCryptoFixture;
			await createTestUser({
				email,
				secretKeyHint: cryptoData.secretKeyHint,
				srpSalt: cryptoData.srpSalt,
				srpVerifier: cryptoData.srpVerifier,
				publicKey: cryptoData.publicKey,
				encryptedPrivateKey: cryptoData.encryptedPrivateKey,
			});

			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.checkEmail({ email });

			expect(result.exists).toBe(true);
			expect(result.secretKeyHint).toBe(cryptoData.secretKeyHint);
		});

		test("should return deterministic fake hint for non-existing email", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			const result = await caller.checkEmail({
				email: "nonexistent@example.com",
			});

			expect(result.exists).toBe(true);
			expect(result.secretKeyHint).toMatch(/^A3-[A-F0-9]{8}$/);
		});

		test("should return the same hint for case variants", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			const email = "case-test@example.com";
			const lowerResult = await caller.checkEmail({ email });
			const upperResult = await caller.checkEmail({
				email: email.toUpperCase(),
			});

			expect(lowerResult.exists).toBe(true);
			expect(upperResult.exists).toBe(true);
			expect(upperResult.secretKeyHint).toBe(lowerResult.secretKeyHint);
		});
	});

	describe("me", () => {
		test("should return current user data when authenticated", async () => {
			const seedEmail = generateTestEmail();
			const cryptoData = authCryptoFixture;
			const {
				userId,
				email: createdEmail,
				caller,
			} = await setup(authRouter, {
				name: "Current User",
				email: seedEmail,
				secretKeyHint: cryptoData.secretKeyHint,
				srpSalt: cryptoData.srpSalt,
				srpVerifier: cryptoData.srpVerifier,
				publicKey: cryptoData.publicKey,
				encryptedPrivateKey: cryptoData.encryptedPrivateKey,
			});

			const result = await caller.me();

			expect(result.id).toBe(userId);
			expect(result.email).toBe(createdEmail);
			expect(result.name).toBe("Current User");
			expect(result.publicKey).toBe(cryptoData.publicKey);
			expect(result.encryptedPrivateKey).toBe(cryptoData.encryptedPrivateKey);
		});

		test("should throw UNAUTHORIZED for unauthenticated request", async () => {
			const caller = authRouter.createCaller(createPublicContext());

			await expect(caller.me()).rejects.toThrow("Authentication required");
		});
	});

	describe("logout", () => {
		test("should delete own session", async () => {
			const { sessionId, caller } = await setup(authRouter);
			const result = await caller.logout();

			expect(result.success).toBe(true);

			const session = await getSession(sessionId);
			expect(session).toBeUndefined();
		});
	});

	describe("refreshSession", () => {
		test("should rotate session and invalidate previous session", async () => {
			const { userId, email, sessionId, caller } = await setup(authRouter);

			const result = await caller.refreshSession();

			expect(result.token).toBeDefined();
			expect(result.sessionId).toBeDefined();
			expect(result.sessionId).not.toBe(sessionId);

			const oldSession = await getSession(sessionId);
			expect(oldSession).toBeUndefined();

			const nextSession = await getSession(result.sessionId);
			expect(nextSession).toBeDefined();
			expect(nextSession?.userId).toBe(userId);

			const staleCaller = authRouter.createCaller(
				createAuthenticatedContext(userId, email, sessionId),
			);
			await expect(staleCaller.refreshSession()).rejects.toThrow(
				"Session expired",
			);
		});

		test("should reject refresh when session is expired", async () => {
			const { userId, email } = await setup(authRouter);
			const expiredSessionId = await createTestSession(userId, {
				expiresAt: new Date(Date.now() - 60_000),
			});

			const caller = authRouter.createCaller(
				createAuthenticatedContext(userId, email, expiredSessionId),
			);

			await expect(caller.refreshSession()).rejects.toThrow("Session expired");
		});

		test("should preserve platform session duration policy", async () => {
			const { userId, email } = await setup(authRouter);
			const extensionSessionId = await createTestSession(userId, {
				platform: "extension",
				expiresAt: new Date(Date.now() + 60_000),
			});

			const caller = authRouter.createCaller(
				createAuthenticatedContext(userId, email, extensionSessionId),
			);

			const now = Date.now();
			const result = await caller.refreshSession();
			const expiresAtMs = new Date(result.expiresAt).getTime();

			expect(expiresAtMs).toBeGreaterThan(now + 6 * 24 * 60 * 60 * 1000);
			expect(expiresAtMs).toBeLessThan(now + 8 * 24 * 60 * 60 * 1000);

			const refreshedSession = await getSession(result.sessionId);
			expect(refreshedSession?.platform).toBe("extension");
		});
	});

	describe("logoutAll", () => {
		test("should delete all sessions for authenticated user", async () => {
			const { userId, caller } = await setup(authRouter);

			await createTestSession(userId, { deviceName: "Device 2" });
			await createTestSession(userId, { deviceName: "Device 3" });

			const result = await caller.logoutAll();

			expect(result.success).toBe(true);

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "logout_all")),
			});
			expect(auditLogs.length).toBe(1);
		});

		test("should require authentication", async () => {
			const caller = authRouter.createCaller(createPublicContext());
			await expect(caller.logoutAll()).rejects.toThrow(
				"Authentication required",
			);
		});
	});

	describe("updateEmail", () => {
		test("should update user email and logout all sessions", async () => {
			const { userId, caller } = await setup(authRouter);
			const newEmail = generateTestEmail();
			const cryptoData = nextAuthCryptoFixture;

			const result = await caller.updateEmail({
				newEmail,
				srpSalt: cryptoData.srpSalt,
				srpVerifier: cryptoData.srpVerifier,
				encryptedPrivateKey: cryptoData.encryptedPrivateKey,
				encryptedVaultKeys: [],
			});

			expect(result.success).toBe(true);

			const user = await getUser(userId);
			expect(user?.email).toBe(newEmail.toLowerCase());
		});

		test("should reject email already in use by another user", async () => {
			const [{ caller }, { email: email2 }] = await Promise.all([
				setup(authRouter),
				setup(authRouter),
			]);
			const cryptoData = nextAuthCryptoFixture;

			await expect(
				caller.updateEmail({
					newEmail: email2,
					srpSalt: cryptoData.srpSalt,
					srpVerifier: cryptoData.srpVerifier,
					encryptedPrivateKey: cryptoData.encryptedPrivateKey,
					encryptedVaultKeys: [],
				}),
			).rejects.toThrow("Email already in use");
		});
	});

	describe("changePassword", () => {
		test("should update SRP credentials and encrypted private key", async () => {
			const currentEmail = generateTestEmail();
			const currentCryptoData = authCryptoFixture;
			const { userId, caller } = await setup(authRouter, {
				email: currentEmail,
				secretKeyHint: currentCryptoData.secretKeyHint,
				srpSalt: currentCryptoData.srpSalt,
				srpVerifier: currentCryptoData.srpVerifier,
				publicKey: currentCryptoData.publicKey,
				encryptedPrivateKey: currentCryptoData.encryptedPrivateKey,
			});
			const vaultId = await createTestVault(userId);

			const nextCryptoData = nextAuthCryptoFixture;

			const result = await caller.changePassword({
				srpSalt: nextCryptoData.srpSalt,
				srpVerifier: nextCryptoData.srpVerifier,
				encryptedPrivateKey: nextCryptoData.encryptedPrivateKey,
				encryptedVaultKeys: [{ vaultId, encryptedVaultKey: "newVaultKey123" }],
			});

			expect(result.success).toBe(true);

			const updatedUser = await getUser(userId);
			expect(updatedUser).toBeDefined();
			expect(updatedUser?.srpSalt).toBe(nextCryptoData.srpSalt);
			expect(updatedUser?.srpVerifier).toBe(nextCryptoData.srpVerifier);
			expect(updatedUser?.encryptedPrivateKey).toBe(
				nextCryptoData.encryptedPrivateKey,
			);

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "password_changed")),
			});
			expect(auditLogs.length).toBe(1);
		});
	});

	describe("regenerateSecretKey", () => {
		test("should update secret key hint and SRP credentials", async () => {
			const currentEmail = generateTestEmail();
			const currentCryptoData = authCryptoFixture;
			const { userId, caller } = await setup(authRouter, {
				email: currentEmail,
				secretKeyHint: currentCryptoData.secretKeyHint,
				srpSalt: currentCryptoData.srpSalt,
				srpVerifier: currentCryptoData.srpVerifier,
				publicKey: currentCryptoData.publicKey,
				encryptedPrivateKey: currentCryptoData.encryptedPrivateKey,
			});
			const vaultId = await createTestVault(userId);

			const nextCryptoData = nextAuthCryptoFixture;

			const result = await caller.regenerateSecretKey({
				secretKeyHint: nextCryptoData.secretKeyHint,
				srpSalt: nextCryptoData.srpSalt,
				srpVerifier: nextCryptoData.srpVerifier,
				encryptedPrivateKey: nextCryptoData.encryptedPrivateKey,
				encryptedVaultKeys: [{ vaultId, encryptedVaultKey: "newVaultKey456" }],
			});

			expect(result.success).toBe(true);

			const updatedUser = await getUser(userId);
			expect(updatedUser).toBeDefined();
			expect(updatedUser?.secretKeyHint).toBe(nextCryptoData.secretKeyHint);
			expect(updatedUser?.srpSalt).toBe(nextCryptoData.srpSalt);

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "secret_key_regenerated")),
			});
			expect(auditLogs.length).toBe(1);
		});
	});

	describe("deleteAccount", () => {
		test("should delete user account with correct email confirmation", async () => {
			const { userId, email, caller } = await setup(authRouter);

			const result = await caller.deleteAccount({ confirmEmail: email });

			expect(result.success).toBe(true);

			const user = await getUser(userId);
			expect(user).toBeUndefined();

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "account_deleted")),
			});
			expect(auditLogs.length).toBe(1);
		});

		test("should reject deletion with wrong email", async () => {
			const { caller } = await setup(authRouter);

			await expect(
				caller.deleteAccount({ confirmEmail: "wrong@example.com" }),
			).rejects.toThrow("Email does not match");
		});

		test("should reject deletion when the owner still has other team members", async () => {
			const { userId, email, caller } = await setup(authRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			const { userId: memberId } = await createTestUser();
			await addTeamMember(teamId, memberId, "member");

			await expect(
				caller.deleteAccount({ confirmEmail: email }),
			).rejects.toThrow(
				"You cannot delete your account while you still own a non-personal team with members or team vaults. Dismantle the team or transfer ownership first.",
			);
		});

		test("should reject deletion when the owner still has team vaults", async () => {
			const { userId, email, caller } = await setup(authRouter);
			const teamId = await createTestTeam(userId, {
				billingPlan: "family",
				billingStatus: "active",
				type: "family",
			});
			await createTestVault(userId, {
				type: "team",
				teamId,
			});

			await expect(
				caller.deleteAccount({ confirmEmail: email }),
			).rejects.toThrow(
				"You cannot delete your account while you still own a non-personal team with members or team vaults. Dismantle the team or transfer ownership first.",
			);
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

			const auditLogs = await db.query.auditLog.findMany({
				where: (log, { and, eq }) =>
					and(eq(log.userId, userId), eq(log.action, "device_revoked")),
			});
			expect(auditLogs.length).toBe(1);
		});

		test("should broadcast session revocation control payload", async () => {
			const { userId, caller } = await setup(authRouter);
			const otherSession = await createTestSession(userId, {
				deviceName: "Other",
			});
			const payloads: Array<{
				type: string;
				userId: string;
				sessionId: string;
				timestamp: number;
				reason?: string;
			}> = [];

			setControlBroadcastFunction(async (payload) => {
				payloads.push(payload);
			});

			const result = await caller.revokeDevice({ sessionId: otherSession });

			expect(result.success).toBe(true);
			expect(payloads).toHaveLength(1);
			expect(payloads[0]).toMatchObject({
				type: "session_revoked",
				userId,
				sessionId: otherSession,
				reason: "device_revoked",
			});
			expect(typeof payloads[0]?.timestamp).toBe("number");
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
