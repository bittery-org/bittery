/**
 * Custom Zero-Knowledge Authentication
 * Uses SRP-6a for secure authentication without server knowing password
 */

import {
	deriveServerSession,
	generateServerEphemeral,
	type SRPServerChallenge,
} from "@bittery/crypto";
import { db, session, user } from "@bittery/db";
import { and, eq, gt } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import { nanoid } from "nanoid";

const JWT_SECRET = new TextEncoder().encode(
	process.env.JWT_SECRET || "bittery-secret-change-in-production",
);
const JWT_ISSUER = "bittery";
const JWT_AUDIENCE = "bittery-users";
const SESSION_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionPayload {
	userId: string;
	email: string;
	sessionId: string;
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
		email: data.email.toLowerCase(),
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
		.where(eq(user.email, email.toLowerCase()))
		.limit(1);

	if (!existingUser) {
		throw new Error("User not found");
	}

	// Generate server ephemeral key pair
	const serverEphemeral = await generateServerEphemeral(
		existingUser.srpVerifier,
	);

	return {
		userId: existingUser.id,
		challenge: {
			salt: existingUser.srpSalt,
			serverPublicKey: serverEphemeral.publicKey,
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

		await db.insert(session).values({
			id: sessionId,
			userId: existingUser.id,
			token: serverSession.key,
			expiresAt,
		});

		// Generate JWT
		// @ts-expect-error -- jose types
		const token = await new SignJWT({
			userId: existingUser.id,
			email: existingUser.email,
			sessionId,
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
		.where(eq(user.email, email.toLowerCase()))
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
export async function createUserSession(userId: string) {
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
	const sessionKey = nanoid(32);

	await db.insert(session).values({
		id: sessionId,
		userId: existingUser.id,
		token: sessionKey,
		expiresAt,
	});

	// Generate JWT
	// @ts-expect-error -- jose types
	const token = await new SignJWT({
		userId: existingUser.id,
		email: existingUser.email,
		sessionId,
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
