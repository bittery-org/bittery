/**
 * Custom Zero-Knowledge Authentication
 * Uses SRP-6a for secure authentication without server knowing password
 */

import { createHash, randomBytes } from "node:crypto";
import {
	deriveServerSession,
	generateServerEphemeral,
} from "@bittery/crypto-napi";
import { db, loginRateLimit, session, user, vaultKey } from "@bittery/db";
import type { SRPServerChallenge } from "@bittery/types";
import { and, eq, gt } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { nanoid } from "nanoid";

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
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days
const LOGIN_RATE_LIMIT_FREE_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_MAX_LOCK_MINUTES = 30;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
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

export interface SessionPayload {
	userId: string;
	email: string;
	sessionId: string;
	sessionTokenHash: string;
}

/**
 * Create a new user (called during signup)
 */
export async function createUser(data: {
	email: string;
	name: string;
	secretKeyHint: string;
	srpSalt: string;
	srpVerifier: string;
	publicKey: string;
	encryptedPrivateKey: string;
}) {
	const userId = nanoid();

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

	const [existingLimit] = await db
		.select()
		.from(loginRateLimit)
		.where(eq(loginRateLimit.id, id))
		.limit(1);

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
	const normalizedIp = ipAddress?.trim() || null;
	const id = getRateLimitId(normalizedEmail, normalizedIp);
	const now = new Date();

	const [existingLimit] = await db
		.select()
		.from(loginRateLimit)
		.where(eq(loginRateLimit.id, id))
		.limit(1);

	const attempts = (existingLimit?.attempts ?? 0) + 1;
	let lockedUntil: Date | null = null;

	if (attempts >= LOGIN_RATE_LIMIT_FREE_ATTEMPTS) {
		const lockMinutes = Math.min(
			LOGIN_RATE_LIMIT_MAX_LOCK_MINUTES,
			2 ** (attempts - LOGIN_RATE_LIMIT_FREE_ATTEMPTS),
		);
		lockedUntil = new Date(now.getTime() + lockMinutes * 60 * 1000);
	}

	if (existingLimit) {
		await db
			.update(loginRateLimit)
			.set({
				attempts,
				lastAttemptAt: now,
				lockedUntil,
			})
			.where(eq(loginRateLimit.id, id));
	} else {
		await db.insert(loginRateLimit).values({
			id,
			email: normalizedEmail,
			ipAddress: normalizedIp,
			attempts,
			lastAttemptAt: now,
			lockedUntil,
		});
	}

	if (lockedUntil && lockedUntil > now) {
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
	await db.delete(loginRateLimit).where(eq(loginRateLimit.id, id));
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
export async function updateUserEmail(userId: string, newEmail: string) {
	await db
		.update(user)
		.set({ email: normalizeEmail(newEmail) })
		.where(eq(user.id, userId));
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
