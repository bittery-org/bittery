/**
 * Custom Zero-Knowledge Authentication
 * Uses SRP-6a for secure authentication without server knowing password
 */

import { createHash, randomBytes } from "node:crypto";
import {
	deriveServerSession,
	generateServerEphemeral,
} from "@bittery/crypto-napi";
import { db, recoveryVerification, session, user, vaultKey } from "@bittery/db";
import type { KdfParams, SRPServerChallenge } from "@bittery/types";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { nanoid } from "nanoid";
import {
	clearRateLimitBySubject,
	clearRateLimitState,
	getRateLimitState,
	RATE_LIMIT_NAMESPACE,
	recordRateLimitFailure,
} from "./rate-limit";

export interface DeviceInfo {
	deviceName?: string;
	platform?: string;
	browserName?: string | null;
	browserVersion?: string | null;
	osName?: string | null;
	osVersion?: string | null;
	userAgent?: string;
	ipAddress?: string | null;
}

const jwtSecretRaw = process.env.JWT_SECRET;
if (!jwtSecretRaw) {
	throw new Error(
		"FATAL: JWT_SECRET environment variable is not set. " +
			"The server cannot start without a secure JWT secret.",
	);
}
if (jwtSecretRaw.length < 32) {
	throw new Error(
		"FATAL: JWT_SECRET must be at least 32 characters for adequate security.",
	);
}

const JWT_SECRET = new TextEncoder().encode(jwtSecretRaw);
const JWT_ISSUER = "bittery";
const JWT_AUDIENCE = "bittery-users";
const RECOVERY_JWT_AUDIENCE = "bittery-recovery";
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days
const RECOVERY_TOKEN_DURATION = "15m";
const LOGIN_RATE_LIMIT_FREE_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_MAX_LOCK_MINUTES = 30;
const RECOVERY_VERIFICATION_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_RATE_LIMIT_NAMESPACE = RATE_LIMIT_NAMESPACE.authLogin;
const RECOVERY_RATE_LIMIT_NAMESPACE = RATE_LIMIT_NAMESPACE.authRecovery;
const LOGIN_KDF_SCHEMA_VERSION = 1 as const;
const LOGIN_KDF_ALGORITHM = "pbkdf2-sha256" as const;
const LOGIN_KDF_ITERATIONS = 310_000;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function buildLoginKdfParams(salt: string): KdfParams {
	return {
		schemaVersion: LOGIN_KDF_SCHEMA_VERSION,
		algorithm: LOGIN_KDF_ALGORITHM,
		iterations: LOGIN_KDF_ITERATIONS,
		salt,
	};
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function getRateLimitId(email: string, ipAddress: string | null): string {
	const ipPart = ipAddress?.trim() || "unknown";
	return createHash("sha256")
		.update(`${normalizeEmail(email)}|${ipPart}`)
		.digest("hex");
}

export class LoginRateLimitError extends Error {
	constructor(message = "Too many login attempts. Please try again later.") {
		super(message);
		this.name = "LoginRateLimitError";
	}
}

export class RecoveryRateLimitError extends Error {
	constructor(message = "Too many recovery attempts. Please try again later.") {
		super(message);
		this.name = "RecoveryRateLimitError";
	}
}

export interface SessionPayload {
	userId: string;
	email: string;
	sessionId: string;
	sessionTokenHash: string;
}

export interface RecoveryTokenPayload {
	email: string;
	type: "recovery";
}

/**
 * Create a new user (called during signup)
 */
export async function createUser(data: {
	id?: string;
	email: string;
	name: string;
	secretKeyHint: string;
	srpSalt: string;
	srpVerifier: string;
	publicKey: string;
	encryptedPrivateKey: string;
	encryptedMasterKey?: string | null;
	recoveryKeyHint?: string | null;
}) {
	const userId = data.id ?? nanoid();

	await db.insert(user).values({
		id: userId,
		email: normalizeEmail(data.email),
		name: data.name,
		emailVerified: false,
		secretKeyHint: data.secretKeyHint,
		srpSalt: data.srpSalt,
		srpVerifier: data.srpVerifier,
		publicKey: data.publicKey,
		encryptedPrivateKey: data.encryptedPrivateKey,
		encryptedMasterKey: data.encryptedMasterKey ?? null,
		recoveryKeyHint: data.recoveryKeyHint ?? null,
	});

	return userId;
}

/**
 * Start SRP login - generate server challenge
 * Step 2 of SRP flow: Server receives client's public ephemeral and responds with its own
 */
export async function startLogin(
	email: string,
	_clientPublicKey: string,
): Promise<{
	userId: string;
	challenge: SRPServerChallenge;
	serverEphemeralSecret: string;
}> {
	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.email, normalizeEmail(email)))
		.limit(1);

	if (!existingUser) {
		throw new Error("User not found");
	}

	// Generate server ephemeral key pair
	const serverEphemeral = generateServerEphemeral(existingUser.srpVerifier);

	return {
		userId: existingUser.id,
		challenge: {
			salt: existingUser.srpSalt,
			serverPublicKey: serverEphemeral.public,
			kdfParams: buildLoginKdfParams(existingUser.srpSalt),
		},
		serverEphemeralSecret: serverEphemeral.secret,
	};
}

/**
 * Finish SRP login - verify proof and create session
 * Step 4 of SRP flow: Server verifies client's proof and derives session key
 */
export async function finishLogin(
	userId: string,
	serverEphemeralSecret: string,
	clientPublicKey: string,
	clientProof: string,
	deviceInfo?: DeviceInfo,
): Promise<{
	success: boolean;
	token?: string;
	sessionId?: string;
	serverProof?: string;
	user?: {
		id: string;
		email: string;
		name: string;
		secretKeyHint: string;
		publicKey: string;
		encryptedPrivateKey: string;
	};
}> {
	// Get user data
	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	if (!existingUser) {
		return { success: false };
	}

	try {
		// Derive server session and verify client proof
		const serverSession = await deriveServerSession(
			serverEphemeralSecret,
			clientPublicKey,
			existingUser.srpSalt,
			existingUser.srpVerifier,
			clientProof,
		);

		// Create session
		const sessionId = nanoid();
		const expiresAt = new Date(Date.now() + SESSION_DURATION);
		const sessionTokenHash = hashToken(serverSession.key);

		await db.insert(session).values({
			id: sessionId,
			userId: existingUser.id,
			token: sessionTokenHash,
			expiresAt,
			// Device tracking fields
			deviceName: deviceInfo?.deviceName,
			platform: deviceInfo?.platform,
			browserName: deviceInfo?.browserName,
			browserVersion: deviceInfo?.browserVersion,
			osName: deviceInfo?.osName,
			osVersion: deviceInfo?.osVersion,
			userAgent: deviceInfo?.userAgent,
			ipAddress: deviceInfo?.ipAddress,
			lastActiveAt: new Date(),
		});

		// Generate JWT
		// @ts-expect-error -- jose types
		const token = await new SignJWT({
			userId: existingUser.id,
			email: existingUser.email,
			sessionId,
			sessionTokenHash,
		} as SessionPayload)
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setIssuer(JWT_ISSUER)
			.setAudience(JWT_AUDIENCE)
			.setExpirationTime("30d")
			.sign(JWT_SECRET);

		return {
			success: true,
			token,
			sessionId,
			serverProof: serverSession.proof,
			user: {
				id: existingUser.id,
				email: existingUser.email,
				name: existingUser.name,
				secretKeyHint: existingUser.secretKeyHint || "",
				publicKey: existingUser.publicKey,
				encryptedPrivateKey: existingUser.encryptedPrivateKey,
			},
		};
	} catch (error) {
		console.error("SRP verification failed:", error);
		return { success: false };
	}
}

/**
 * Verify JWT token and get session
 */
export async function verifySession(
	token: string,
): Promise<SessionPayload | null> {
	try {
		const { payload } = await jwtVerify(token, JWT_SECRET, {
			issuer: JWT_ISSUER,
			audience: JWT_AUDIENCE,
		});

		const sessionPayload = payload as unknown as SessionPayload;

		// Check if session still exists and is valid
		const [existingSession] = await db
			.select()
			.from(session)
			.where(
				and(
					eq(session.id, sessionPayload.sessionId),
					eq(session.userId, sessionPayload.userId),
					eq(session.token, sessionPayload.sessionTokenHash),
					gt(session.expiresAt, new Date()),
				),
			)
			.limit(1);

		if (!existingSession) {
			return null;
		}

		return sessionPayload;
	} catch {
		return null;
	}
}

/**
 * Create short-lived recovery token after successful recovery code verification
 */
export async function createRecoveryToken(email: string): Promise<string> {
	const normalizedEmail = normalizeEmail(email);

	// @ts-expect-error -- jose types
	return new SignJWT({
		email: normalizedEmail,
		type: "recovery",
	} as RecoveryTokenPayload)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setIssuer(JWT_ISSUER)
		.setAudience(RECOVERY_JWT_AUDIENCE)
		.setExpirationTime(RECOVERY_TOKEN_DURATION)
		.sign(JWT_SECRET);
}

/**
 * Verify short-lived recovery token
 */
export async function verifyRecoveryToken(
	token: string,
): Promise<RecoveryTokenPayload | null> {
	try {
		const { payload } = await jwtVerify(token, JWT_SECRET, {
			issuer: JWT_ISSUER,
			audience: RECOVERY_JWT_AUDIENCE,
		});

		const email = typeof payload.email === "string" ? payload.email : null;
		const type = payload.type;

		if (!email || type !== "recovery") {
			return null;
		}

		return {
			email: normalizeEmail(email),
			type: "recovery",
		};
	} catch {
		return null;
	}
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string) {
	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.email, normalizeEmail(email)))
		.limit(1);

	return existingUser || null;
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string) {
	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	return existingUser || null;
}

/**
 * Store or update encrypted master key recovery metadata
 */
export async function storeEncryptedMasterKey(
	userId: string,
	encryptedMasterKey: string,
	recoveryKeyHint: string,
) {
	await db
		.update(user)
		.set({
			encryptedMasterKey,
			recoveryKeyHint,
		})
		.where(eq(user.id, userId));
}

/**
 * Create a user session and return JWT token
 * Used after signup or when creating a session without SRP
 */
export async function createUserSession(
	userId: string,
	deviceInfo?: DeviceInfo,
) {
	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	if (!existingUser) {
		throw new Error("User not found");
	}

	// Create session
	const sessionId = nanoid();
	const expiresAt = new Date(Date.now() + SESSION_DURATION);

	// Generate a random session key for non-SRP sessions
	const sessionKey = randomBytes(32).toString("base64url");
	const sessionTokenHash = hashToken(sessionKey);

	await db.insert(session).values({
		id: sessionId,
		userId: existingUser.id,
		token: sessionTokenHash,
		expiresAt,
		// Device tracking fields
		deviceName: deviceInfo?.deviceName,
		platform: deviceInfo?.platform,
		browserName: deviceInfo?.browserName,
		browserVersion: deviceInfo?.browserVersion,
		osName: deviceInfo?.osName,
		osVersion: deviceInfo?.osVersion,
		userAgent: deviceInfo?.userAgent,
		ipAddress: deviceInfo?.ipAddress,
		lastActiveAt: new Date(),
	});

	// Generate JWT
	// @ts-expect-error -- jose types
	const token = await new SignJWT({
		userId: existingUser.id,
		email: existingUser.email,
		sessionId,
		sessionTokenHash,
	} as SessionPayload)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setIssuer(JWT_ISSUER)
		.setAudience(JWT_AUDIENCE)
		.setExpirationTime("30d")
		.sign(JWT_SECRET);

	return {
		token,
		sessionId,
		user: {
			id: existingUser.id,
			email: existingUser.email,
			name: existingUser.name,
			secretKeyHint: existingUser.secretKeyHint || "",
			publicKey: existingUser.publicKey,
			encryptedPrivateKey: existingUser.encryptedPrivateKey,
		},
	};
}

/**
 * Delete session (logout)
 */
export async function deleteSession(sessionId: string) {
	await db.delete(session).where(eq(session.id, sessionId));
}

/**
 * Delete all user sessions (logout from all devices)
 */
export async function deleteAllUserSessions(userId: string) {
	await db.delete(session).where(eq(session.userId, userId));
}

/**
 * Delete all user sessions except the specified one (e.g. the current session)
 */
export async function deleteOtherUserSessions(
	userId: string,
	currentSessionId: string,
) {
	await db
		.delete(session)
		.where(and(eq(session.userId, userId), ne(session.id, currentSessionId)));
}

/**
 * Get session by ID
 */
export async function getSessionById(sessionId: string) {
	const [existingSession] = await db
		.select()
		.from(session)
		.where(eq(session.id, sessionId))
		.limit(1);

	return existingSession || null;
}

/**
 * Check whether login attempts are currently rate-limited for an email + IP pair
 */
export async function checkLoginRateLimit(
	email: string,
	ipAddress: string | null,
): Promise<void> {
	const id = getRateLimitId(email, ipAddress);
	const now = new Date();

	const existingLimit = await getRateLimitState(LOGIN_RATE_LIMIT_NAMESPACE, id);

	if (existingLimit?.lockedUntil && existingLimit.lockedUntil > now) {
		throw new LoginRateLimitError();
	}
}

/**
 * Record failed login attempt and potentially lock future attempts
 */
export async function recordFailedLoginAttempt(
	email: string,
	ipAddress: string | null,
): Promise<void> {
	const normalizedEmail = normalizeEmail(email);
	const id = getRateLimitId(normalizedEmail, ipAddress?.trim() || null);
	const now = new Date();

	const state = await recordRateLimitFailure({
		namespace: LOGIN_RATE_LIMIT_NAMESPACE,
		key: id,
		subject: normalizedEmail,
		now,
		freeAttempts: LOGIN_RATE_LIMIT_FREE_ATTEMPTS,
		maxLockMinutes: LOGIN_RATE_LIMIT_MAX_LOCK_MINUTES,
	});

	if (state.lockedUntil && state.lockedUntil > now) {
		throw new LoginRateLimitError();
	}
}

/**
 * Clear failed login attempts after a successful login
 */
export async function clearLoginRateLimit(
	email: string,
	ipAddress: string | null,
): Promise<void> {
	const id = getRateLimitId(email, ipAddress?.trim() || null);
	await clearRateLimitState(LOGIN_RATE_LIMIT_NAMESPACE, id);
}

function generateRecoveryVerificationCode(): string {
	return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Create a new recovery verification code (6 digits, 15 minutes).
 */
export async function createRecoveryVerification(
	email: string,
): Promise<string> {
	const normalizedEmail = normalizeEmail(email);
	const now = new Date();
	const code = generateRecoveryVerificationCode();

	// Invalidate previous active codes so only one can be used at a time.
	await db
		.update(recoveryVerification)
		.set({ usedAt: now })
		.where(
			and(
				eq(recoveryVerification.email, normalizedEmail),
				isNull(recoveryVerification.usedAt),
			),
		);

	await db.insert(recoveryVerification).values({
		id: nanoid(),
		email: normalizedEmail,
		code,
		expiresAt: new Date(now.getTime() + RECOVERY_VERIFICATION_DURATION_MS),
	});

	return code;
}

/**
 * Verify recovery code. Returns false on failure and increments attempt counters.
 */
export async function verifyRecoveryCode(
	email: string,
	code: string,
): Promise<boolean> {
	const normalizedEmail = normalizeEmail(email);
	const now = new Date();

	const validVerification = await db.query.recoveryVerification.findFirst({
		where: (record, { and, eq, gt, isNull }) =>
			and(
				eq(record.email, normalizedEmail),
				eq(record.code, code),
				gt(record.expiresAt, now),
				isNull(record.usedAt),
			),
		orderBy: (record, { desc }) => [desc(record.createdAt)],
	});

	if (validVerification) {
		if (validVerification.attempts >= validVerification.maxAttempts) {
			return false;
		}
		return true;
	}

	// Increment attempts for the latest active verification to mitigate brute forcing.
	const activeVerification = await db.query.recoveryVerification.findFirst({
		where: (record, { and, eq, gt, isNull }) =>
			and(
				eq(record.email, normalizedEmail),
				gt(record.expiresAt, now),
				isNull(record.usedAt),
			),
		orderBy: (record, { desc }) => [desc(record.createdAt)],
	});

	if (activeVerification) {
		const nextAttempts = activeVerification.attempts + 1;
		await db
			.update(recoveryVerification)
			.set({
				attempts: nextAttempts,
				...(nextAttempts >= activeVerification.maxAttempts
					? { usedAt: now }
					: {}),
			})
			.where(eq(recoveryVerification.id, activeVerification.id));
	}

	return false;
}

/**
 * Check whether recovery attempts are currently rate-limited for an email + IP pair
 */
export async function checkRecoveryRateLimit(
	email: string,
	ipAddress: string | null,
): Promise<void> {
	const id = getRateLimitId(email, ipAddress);
	const now = new Date();

	const existingLimit = await getRateLimitState(
		RECOVERY_RATE_LIMIT_NAMESPACE,
		id,
	);

	if (existingLimit?.lockedUntil && existingLimit.lockedUntil > now) {
		throw new RecoveryRateLimitError();
	}
}

/**
 * Record failed recovery attempt and potentially lock future attempts
 */
export async function recordFailedRecoveryAttempt(
	email: string,
	ipAddress: string | null,
): Promise<void> {
	const normalizedEmail = normalizeEmail(email);
	const id = getRateLimitId(normalizedEmail, ipAddress?.trim() || null);
	const now = new Date();

	const state = await recordRateLimitFailure({
		namespace: RECOVERY_RATE_LIMIT_NAMESPACE,
		key: id,
		subject: normalizedEmail,
		now,
		freeAttempts: LOGIN_RATE_LIMIT_FREE_ATTEMPTS,
		maxLockMinutes: LOGIN_RATE_LIMIT_MAX_LOCK_MINUTES,
	});

	if (state.lockedUntil && state.lockedUntil > now) {
		throw new RecoveryRateLimitError();
	}
}

/**
 * Clear failed recovery attempts after a successful recovery
 */
export async function clearRecoveryRateLimit(
	email: string,
	ipAddress: string | null,
): Promise<void> {
	const id = getRateLimitId(email, ipAddress?.trim() || null);
	await clearRateLimitState(RECOVERY_RATE_LIMIT_NAMESPACE, id);
}

/**
 * Get encrypted recovery metadata for a verified recovery session
 */
export async function getRecoveryData(email: string): Promise<{
	userId: string;
	encryptedMasterKey: string;
	encryptedPrivateKey: string;
	secretKeyHint: string | null;
	recoveryKeyHint: string | null;
} | null> {
	const normalizedEmail = normalizeEmail(email);
	const now = new Date();

	const activeVerification = await db.query.recoveryVerification.findFirst({
		where: (record, { and, eq, gt, isNull }) =>
			and(
				eq(record.email, normalizedEmail),
				gt(record.expiresAt, now),
				isNull(record.usedAt),
			),
		orderBy: (record, { desc }) => [desc(record.createdAt)],
	});

	if (!activeVerification) {
		return null;
	}

	const existingUser = await db.query.user.findFirst({
		where: (record, { eq }) => eq(record.email, normalizedEmail),
		columns: {
			id: true,
			encryptedMasterKey: true,
			encryptedPrivateKey: true,
			secretKeyHint: true,
			recoveryKeyHint: true,
		},
	});

	if (!existingUser?.encryptedMasterKey) {
		return null;
	}

	return {
		userId: existingUser.id,
		encryptedMasterKey: existingUser.encryptedMasterKey,
		encryptedPrivateKey: existingUser.encryptedPrivateKey,
		secretKeyHint: existingUser.secretKeyHint,
		recoveryKeyHint: existingUser.recoveryKeyHint,
	};
}

/**
 * Get all vault keys for recovery (includes vault creator to identify MUK-encrypted keys)
 */
export async function getUserVaultKeysForRecovery(userId: string): Promise<
	Array<{
		vaultId: string;
		encryptedVaultKey: string;
		createdById: string;
	}>
> {
	const userVaultKeys = await db.query.vaultKey.findMany({
		where: (record, { eq }) => eq(record.userId, userId),
		with: {
			vault: {
				columns: {
					id: true,
					createdById: true,
				},
			},
		},
		orderBy: (record, { desc }) => [desc(record.createdAt)],
	});

	return userVaultKeys.map((record) => ({
		vaultId: record.vaultId,
		encryptedVaultKey: record.encryptedVaultKey,
		createdById: record.vault.createdById,
	}));
}

/**
 * Reset user password and recovery metadata in a single transaction.
 * Also invalidates existing sessions and marks recovery verification as used.
 */
export async function resetUserPassword(
	email: string,
	data: {
		srpSalt: string;
		srpVerifier: string;
		encryptedPrivateKey: string;
		encryptedMasterKey: string;
		recoveryKeyHint: string;
		secretKeyHint?: string;
		encryptedVaultKeys: Array<{
			vaultId: string;
			encryptedVaultKey: string;
		}>;
	},
): Promise<string> {
	const normalizedEmail = normalizeEmail(email);
	const now = new Date();

	const userId = await db.transaction(async (tx) => {
		const existingVerification = await tx.query.recoveryVerification.findFirst({
			where: (record, { and, eq, gt, isNull }) =>
				and(
					eq(record.email, normalizedEmail),
					gt(record.expiresAt, now),
					isNull(record.usedAt),
				),
			orderBy: (record, { desc }) => [desc(record.createdAt)],
		});

		if (!existingVerification) {
			throw new Error("Recovery session expired or already used");
		}

		const existingUser = await tx.query.user.findFirst({
			where: (record, { eq }) => eq(record.email, normalizedEmail),
			columns: { id: true },
		});

		if (!existingUser) {
			throw new Error("Recovery session expired or already used");
		}

		await tx
			.update(user)
			.set({
				srpSalt: data.srpSalt,
				srpVerifier: data.srpVerifier,
				encryptedPrivateKey: data.encryptedPrivateKey,
				encryptedMasterKey: data.encryptedMasterKey,
				recoveryKeyHint: data.recoveryKeyHint,
				...(data.secretKeyHint ? { secretKeyHint: data.secretKeyHint } : {}),
			})
			.where(eq(user.id, existingUser.id));

		for (const vk of data.encryptedVaultKeys) {
			await tx
				.update(vaultKey)
				.set({ encryptedVaultKey: vk.encryptedVaultKey })
				.where(
					and(
						eq(vaultKey.vaultId, vk.vaultId),
						eq(vaultKey.userId, existingUser.id),
					),
				);
		}

		await tx.delete(session).where(eq(session.userId, existingUser.id));
		await tx
			.update(recoveryVerification)
			.set({ usedAt: now })
			.where(eq(recoveryVerification.id, existingVerification.id));

		return existingUser.id;
	});

	// Recovery lockouts should be lifted after a successful password reset.
	try {
		await clearRateLimitBySubject(
			RECOVERY_RATE_LIMIT_NAMESPACE,
			normalizedEmail,
		);
	} catch (error) {
		console.warn(
			"[auth] Failed to clear recovery rate limits after password reset:",
			error,
		);
	}

	return userId;
}

/**
 * Get all sessions for a user
 */
export async function getUserSessions(userId: string) {
	const sessions = await db
		.select()
		.from(session)
		.where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
		.orderBy(session.lastActiveAt);

	return sessions.map((s) => ({
		id: s.id,
		deviceName: s.deviceName,
		platform: s.platform,
		browserName: s.browserName,
		browserVersion: s.browserVersion,
		osName: s.osName,
		osVersion: s.osVersion,
		ipAddress: s.ipAddress,
		lastActiveAt: s.lastActiveAt,
		createdAt: s.createdAt,
	}));
}

/**
 * Revoke a specific session (must belong to user)
 */
export async function revokeSession(
	sessionId: string,
	userId: string,
): Promise<void> {
	await db
		.delete(session)
		.where(and(eq(session.id, sessionId), eq(session.userId, userId)));
}

/**
 * Update session's last active timestamp
 */
export async function updateSessionActivity(sessionId: string) {
	await db
		.update(session)
		.set({ lastActiveAt: new Date() })
		.where(eq(session.id, sessionId));
}

/**
 * Rename a device/session
 */
export async function renameSession(
	sessionId: string,
	userId: string,
	deviceName: string,
) {
	await db
		.update(session)
		.set({ deviceName })
		.where(and(eq(session.id, sessionId), eq(session.userId, userId)));
}

/**
 * Update user email
 */
export async function updateUserEmail(
	userId: string,
	data: {
		newEmail: string;
		srpSalt: string;
		srpVerifier: string;
		encryptedPrivateKey: string;
		encryptedVaultKeys: Array<{
			vaultId: string;
			encryptedVaultKey: string;
		}>;
	},
) {
	// Update email, SRP credentials, and re-encrypted private key
	await db
		.update(user)
		.set({
			email: normalizeEmail(data.newEmail),
			srpSalt: data.srpSalt,
			srpVerifier: data.srpVerifier,
			encryptedPrivateKey: data.encryptedPrivateKey,
			encryptedMasterKey: null,
			recoveryKeyHint: null,
		})
		.where(eq(user.id, userId));

	// Update all vault keys with new encryption
	for (const vk of data.encryptedVaultKeys) {
		await db
			.update(vaultKey)
			.set({ encryptedVaultKey: vk.encryptedVaultKey })
			.where(
				and(eq(vaultKey.vaultId, vk.vaultId), eq(vaultKey.userId, userId)),
			);
	}
}

/**
 * Update user password (SRP credentials), re-encrypted private key, and vault keys
 */
export async function updateUserPassword(
	userId: string,
	data: {
		srpSalt: string;
		srpVerifier: string;
		encryptedPrivateKey: string;
		encryptedVaultKeys: Array<{
			vaultId: string;
			encryptedVaultKey: string;
		}>;
	},
) {
	// Update user credentials
	await db
		.update(user)
		.set({
			srpSalt: data.srpSalt,
			srpVerifier: data.srpVerifier,
			encryptedPrivateKey: data.encryptedPrivateKey,
			encryptedMasterKey: null,
			recoveryKeyHint: null,
		})
		.where(eq(user.id, userId));

	// Update all vault keys with new encryption
	for (const vk of data.encryptedVaultKeys) {
		await db
			.update(vaultKey)
			.set({ encryptedVaultKey: vk.encryptedVaultKey })
			.where(
				and(eq(vaultKey.vaultId, vk.vaultId), eq(vaultKey.userId, userId)),
			);
	}
}

/**
 * Update user secret key (regenerate) with new SRP credentials, re-encrypted data, and vault keys
 */
export async function updateUserSecretKey(
	userId: string,
	data: {
		secretKeyHint: string;
		srpSalt: string;
		srpVerifier: string;
		encryptedPrivateKey: string;
		encryptedVaultKeys: Array<{
			vaultId: string;
			encryptedVaultKey: string;
		}>;
	},
) {
	// Update user credentials
	await db
		.update(user)
		.set({
			secretKeyHint: data.secretKeyHint,
			srpSalt: data.srpSalt,
			srpVerifier: data.srpVerifier,
			encryptedPrivateKey: data.encryptedPrivateKey,
			encryptedMasterKey: null,
			recoveryKeyHint: null,
		})
		.where(eq(user.id, userId));

	// Update all vault keys with new encryption
	for (const vk of data.encryptedVaultKeys) {
		await db
			.update(vaultKey)
			.set({ encryptedVaultKey: vk.encryptedVaultKey })
			.where(
				and(eq(vaultKey.vaultId, vk.vaultId), eq(vaultKey.userId, userId)),
			);
	}
}

/**
 * Delete user account and all associated data
 * Note: Cascading deletes will handle sessions, vault keys, etc.
 */
export async function deleteUserAccount(userId: string) {
	await db.delete(user).where(eq(user.id, userId));
}
