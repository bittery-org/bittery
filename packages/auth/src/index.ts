/**
 * Custom Zero-Knowledge Authentication
 * Uses SRP-6a for secure authentication without server knowing password
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import {
	deriveServerSession,
	generateServerEphemeral,
} from "@bittery/crypto-napi";
import {
	db,
	loginAttempt,
	recoveryVerification,
	session,
	signupVerification,
	user,
	vaultKey,
} from "@bittery/db";
import type { KdfParams, SRPServerChallenge } from "@bittery/types";
import { and, eq, gt, isNull, lte, ne } from "drizzle-orm";
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
	clientId?: string | null;
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

const JWT_SECRET_RAW = jwtSecretRaw;
const JWT_SECRET = new TextEncoder().encode(jwtSecretRaw);
const JWT_ISSUER = "bittery";
const RECOVERY_JWT_AUDIENCE = "bittery-recovery";
const SIGNUP_VERIFICATION_JWT_AUDIENCE = "bittery-signup-verification";
const DEFAULT_SESSION_DURATION = 30 * 24 * 60 * 60 * 1000;
const SESSION_DURATION_BY_PLATFORM: Record<string, number> = {
	web: 24 * 60 * 60 * 1000,
	desktop: 30 * 24 * 60 * 60 * 1000,
	mobile: 30 * 24 * 60 * 60 * 1000,
	extension: 7 * 24 * 60 * 60 * 1000,
	ios: 30 * 24 * 60 * 60 * 1000,
	android: 30 * 24 * 60 * 60 * 1000,
};
const RECOVERY_TOKEN_DURATION = "15m";
const SIGNUP_VERIFICATION_TOKEN_DURATION = "15m";
const LOGIN_ATTEMPT_TTL_MS = 60 * 1000;
const LOGIN_RATE_LIMIT_FREE_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_MAX_LOCK_MINUTES = 30;
const RECOVERY_VERIFICATION_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const SIGNUP_VERIFICATION_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_RATE_LIMIT_NAMESPACE = RATE_LIMIT_NAMESPACE.authLoginAccount;
const RECOVERY_RATE_LIMIT_NAMESPACE = RATE_LIMIT_NAMESPACE.authRecovery;
const LOGIN_KDF_SCHEMA_VERSION = 1 as const;
const LOGIN_KDF_ALGORITHM = "pbkdf2-sha256" as const;
const LOGIN_KDF_ITERATIONS = 310_000;
const FAKE_SRP_VERIFIER =
	"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
	"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
	"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
	"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

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

function hashNormalizedEmail(normalizedEmail: string): string {
	return createHash("sha256").update(normalizedEmail).digest("hex");
}

function buildLoginAttemptId(normalizedEmailHash: string): string {
	return `${normalizedEmailHash}:${nanoid()}`;
}

export function getLoginAccountRateLimitKey(email: string): string {
	return hashNormalizedEmail(normalizeEmail(email));
}

export function extractLoginAttemptRateLimitKey(
	attemptId: string,
): string | null {
	const [normalizedEmailHash] = attemptId.split(":", 1);
	if (!normalizedEmailHash || !/^[a-f0-9]{64}$/.test(normalizedEmailHash)) {
		return null;
	}
	return normalizedEmailHash;
}

function buildFakeLoginSalt(normalizedEmail: string): string {
	return createHmac("sha256", JWT_SECRET_RAW)
		.update(normalizedEmail)
		.digest("hex");
}

function matchOptionalInvitationToken(invitationToken: string | null) {
	return invitationToken === null
		? isNull(signupVerification.invitationToken)
		: eq(signupVerification.invitationToken, invitationToken);
}

function getScopedRateLimitId(email: string, ipAddress: string | null): string {
	const ipPart = ipAddress?.trim() || "unknown";
	return createHash("sha256")
		.update(`${normalizeEmail(email)}|${ipPart}`)
		.digest("hex");
}

function generateOpaqueSessionToken(): string {
	return randomBytes(32).toString("base64url");
}

function normalizeSessionPlatform(platform?: string): string {
	if (!platform) return "desktop";
	const normalized = platform.toLowerCase();
	if (normalized === "ios" || normalized === "android") return "mobile";
	if (
		normalized === "web" ||
		normalized === "desktop" ||
		normalized === "mobile" ||
		normalized === "extension"
	) {
		return normalized;
	}
	return "desktop";
}

function getSessionDurationMs(platform?: string): number {
	const normalized = normalizeSessionPlatform(platform);
	return SESSION_DURATION_BY_PLATFORM[normalized] ?? DEFAULT_SESSION_DURATION;
}

type SessionRow = typeof session.$inferSelect;
type DbTransaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

function resolveSessionClientId(
	platform: string,
	clientId?: string | null,
): string | null {
	if (platform !== "web") {
		return null;
	}

	const normalizedClientId = clientId?.trim();
	return normalizedClientId ? normalizedClientId : null;
}

function isGroupedWebSession(
	value: Pick<SessionRow, "platform" | "clientId">,
): value is Pick<SessionRow, "platform" | "clientId"> & {
	platform: "web";
	clientId: string;
} {
	return value.platform === "web" && typeof value.clientId === "string";
}

function compareSessionRecency(a: SessionRow, b: SessionRow): number {
	return (
		b.lastActiveAt.getTime() - a.lastActiveAt.getTime() ||
		b.createdAt.getTime() - a.createdAt.getTime() ||
		b.id.localeCompare(a.id)
	);
}

async function issueSession(params: {
	userId: string;
	deviceInfo?: DeviceInfo;
	replaceSessionId?: string;
}): Promise<{
	token: string;
	sessionId: string;
	expiresAt: Date;
}> {
	const issuedAt = new Date();
	const opaqueToken = generateOpaqueSessionToken();
	const nextSessionId = hashToken(opaqueToken);
	const platform = normalizeSessionPlatform(params.deviceInfo?.platform);
	const clientId = resolveSessionClientId(platform, params.deviceInfo?.clientId);
	const expiresAt = new Date(issuedAt.getTime() + getSessionDurationMs(platform));

	await db.transaction(async (tx) => {
		let deviceName = params.deviceInfo?.deviceName ?? null;
		const shouldReplaceGroupedWebSession =
			platform === "web" && clientId !== null;

		if (shouldReplaceGroupedWebSession) {
			const groupedSessions = await tx
				.select()
				.from(session)
				.where(
					and(
						eq(session.userId, params.userId),
						eq(session.platform, platform),
						eq(session.clientId, clientId),
					),
				);
			const newestGroupedSession = [...groupedSessions].sort(compareSessionRecency)[0];

			if (newestGroupedSession?.deviceName) {
				deviceName = newestGroupedSession.deviceName;
			}

			await tx
				.delete(session)
				.where(
					and(
						eq(session.userId, params.userId),
						eq(session.platform, platform),
						eq(session.clientId, clientId),
					),
				);
		}

		await tx.insert(session).values({
			id: nextSessionId,
			userId: params.userId,
			expiresAt,
			deviceName,
			platform,
			clientId,
			deviceInfo: params.deviceInfo?.userAgent,
			browserName: params.deviceInfo?.browserName,
			browserVersion: params.deviceInfo?.browserVersion,
			osName: params.deviceInfo?.osName,
			osVersion: params.deviceInfo?.osVersion,
			userAgent: params.deviceInfo?.userAgent,
			ipAddress: params.deviceInfo?.ipAddress,
			lastActiveAt: issuedAt,
		});

		if (params.replaceSessionId && !shouldReplaceGroupedWebSession) {
			await tx.delete(session).where(eq(session.id, params.replaceSessionId));
		}
	});

	return {
		token: opaqueToken,
		sessionId: nextSessionId,
		expiresAt,
	};
}

async function getOwnedSession(
	sessionId: string,
	userId: string,
	tx: DbTransaction | typeof db = db,
): Promise<SessionRow | null> {
	const [existingSession] = await tx
		.select()
		.from(session)
		.where(and(eq(session.id, sessionId), eq(session.userId, userId)))
		.limit(1);

	return existingSession ?? null;
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
	sessionId: string;
	expiresAt: Date;
	platform?: string | null;
}

export interface RecoveryTokenPayload {
	email: string;
	type: "recovery";
}

export interface SignupVerificationTokenPayload {
	email: string;
	invitationToken?: string;
	type: "signup_verification";
}

/**
 * Create a new user (called during signup)
 */
export async function createUser(data: {
	id?: string;
	email: string;
	name: string;
	emailVerified?: boolean;
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
		emailVerified: data.emailVerified ?? false,
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
	clientPublicKey: string,
): Promise<{
	attemptId: string;
	challenge: SRPServerChallenge;
}> {
	const normalizedEmail = normalizeEmail(email);
	const normalizedEmailHash = hashNormalizedEmail(normalizedEmail);
	const now = new Date();

	await db.delete(loginAttempt).where(lte(loginAttempt.expiresAt, now));

	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.email, normalizedEmail))
		.limit(1);

	const srpSalt = existingUser
		? existingUser.srpSalt
		: buildFakeLoginSalt(normalizedEmail);
	const srpVerifier = existingUser?.srpVerifier ?? FAKE_SRP_VERIFIER;
	const serverEphemeral = generateServerEphemeral(srpVerifier);
	const attemptId = buildLoginAttemptId(normalizedEmailHash);
	const expiresAt = new Date(now.getTime() + LOGIN_ATTEMPT_TTL_MS);

	await db.insert(loginAttempt).values({
		id: attemptId,
		userId: existingUser?.id ?? null,
		normalizedEmailHash,
		clientPublicKey,
		serverEphemeralSecret: serverEphemeral.secret,
		expiresAt,
	});

	return {
		attemptId,
		challenge: {
			salt: srpSalt,
			serverPublicKey: serverEphemeral.public,
			kdfParams: buildLoginKdfParams(srpSalt),
		},
	};
}

/**
 * Finish SRP login - verify proof and create session
 * Step 4 of SRP flow: Server verifies client's proof and derives session key
 */
export async function finishLogin(
	attemptId: string,
	clientPublicKey: string,
	clientProof: string,
	deviceInfo?: DeviceInfo,
): Promise<{
	success: boolean;
	normalizedEmailHash?: string | null;
	token?: string;
	sessionId?: string;
	expiresAt?: Date;
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
	const now = new Date();
	const existingAttempt = await db.query.loginAttempt.findFirst({
		where: (record, { eq: eqFn }) => eqFn(record.id, attemptId),
	});
	const fallbackHash = extractLoginAttemptRateLimitKey(attemptId);

	if (!existingAttempt) {
		return {
			success: false,
			normalizedEmailHash: fallbackHash,
		};
	}

	const normalizedEmailHash =
		existingAttempt.normalizedEmailHash ?? fallbackHash ?? null;

	if (existingAttempt.expiresAt <= now) {
		await db.delete(loginAttempt).where(eq(loginAttempt.id, attemptId));
		return {
			success: false,
			normalizedEmailHash,
		};
	}

	if (existingAttempt.clientPublicKey !== clientPublicKey) {
		await db.delete(loginAttempt).where(eq(loginAttempt.id, attemptId));
		return {
			success: false,
			normalizedEmailHash,
		};
	}

	await db.delete(loginAttempt).where(eq(loginAttempt.id, attemptId));

	if (!existingAttempt.userId) {
		return {
			success: false,
			normalizedEmailHash,
		};
	}

	const [existingUser] = await db
		.select()
		.from(user)
		.where(eq(user.id, existingAttempt.userId))
		.limit(1);

	if (!existingUser) {
		return {
			success: false,
			normalizedEmailHash,
		};
	}

	try {
		const serverSession = await deriveServerSession(
			existingAttempt.serverEphemeralSecret,
			clientPublicKey,
			existingUser.srpSalt,
			existingUser.srpVerifier,
			clientProof,
		);
		const issuedSession = await issueSession({
			userId: existingUser.id,
			deviceInfo,
		});

		return {
			success: true,
			normalizedEmailHash,
			token: issuedSession.token,
			sessionId: issuedSession.sessionId,
			expiresAt: issuedSession.expiresAt,
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
		return {
			success: false,
			normalizedEmailHash,
		};
	}
}

/**
 * Verify opaque bearer token and resolve active session
 */
export async function verifySession(
	token: string,
): Promise<SessionPayload | null> {
	if (!token) {
		return null;
	}

	try {
		const hashedId = hashToken(token);
		const [existingSession] = await db
			.select()
			.from(session)
			.where(and(eq(session.id, hashedId), gt(session.expiresAt, new Date())))
			.limit(1);

		if (!existingSession) {
			return null;
		}

		return {
			userId: existingSession.userId,
			sessionId: existingSession.id,
			expiresAt: existingSession.expiresAt,
			platform: existingSession.platform,
		};
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

export async function createSignupVerificationToken(input: {
	email: string;
	invitationToken?: string;
}): Promise<string> {
	const normalizedEmail = normalizeEmail(input.email);

	// @ts-expect-error -- jose types
	return new SignJWT({
		email: normalizedEmail,
		invitationToken: input.invitationToken,
		type: "signup_verification",
	} as SignupVerificationTokenPayload)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setIssuer(JWT_ISSUER)
		.setAudience(SIGNUP_VERIFICATION_JWT_AUDIENCE)
		.setExpirationTime(SIGNUP_VERIFICATION_TOKEN_DURATION)
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

export async function verifySignupVerificationToken(
	token: string,
): Promise<SignupVerificationTokenPayload | null> {
	try {
		const { payload } = await jwtVerify(token, JWT_SECRET, {
			issuer: JWT_ISSUER,
			audience: SIGNUP_VERIFICATION_JWT_AUDIENCE,
		});

		const email = typeof payload.email === "string" ? payload.email : null;
		const invitationToken =
			typeof payload.invitationToken === "string"
				? payload.invitationToken
				: undefined;
		const type = payload.type;

		if (!email || type !== "signup_verification") {
			return null;
		}

		return {
			email: normalizeEmail(email),
			invitationToken,
			type: "signup_verification",
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
 * Create a user session and return opaque bearer token
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

	const issuedSession = await issueSession({
		userId: existingUser.id,
		deviceInfo,
	});

	return {
		token: issuedSession.token,
		sessionId: issuedSession.sessionId,
		expiresAt: issuedSession.expiresAt,
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

export async function refreshSession(currentSessionId: string): Promise<{
	token: string;
	sessionId: string;
	expiresAt: Date;
}> {
	const [existingSession] = await db
		.select()
		.from(session)
		.where(
			and(eq(session.id, currentSessionId), gt(session.expiresAt, new Date())),
		)
		.limit(1);

	if (!existingSession) {
		throw new Error("Session not found");
	}
	const issuedSession = await issueSession({
		userId: existingSession.userId,
		replaceSessionId: currentSessionId,
		deviceInfo: {
			deviceName: existingSession.deviceName ?? undefined,
			platform: existingSession.platform ?? undefined,
			clientId: existingSession.clientId,
			browserName: existingSession.browserName,
			browserVersion: existingSession.browserVersion,
			osName: existingSession.osName,
			osVersion: existingSession.osVersion,
			userAgent: existingSession.userAgent ?? undefined,
			ipAddress: existingSession.ipAddress,
		},
	});

	return {
		token: issuedSession.token,
		sessionId: issuedSession.sessionId,
		expiresAt: issuedSession.expiresAt,
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
 * Check whether login attempts are currently rate-limited for an account.
 */
export async function checkLoginRateLimit(
	accountRateLimitKey: string,
): Promise<void> {
	const now = new Date();

	const existingLimit = await getRateLimitState(
		LOGIN_RATE_LIMIT_NAMESPACE,
		accountRateLimitKey,
	);

	if (existingLimit?.lockedUntil && existingLimit.lockedUntil > now) {
		throw new LoginRateLimitError();
	}
}

/**
 * Record failed login attempt and potentially lock future attempts
 */
export async function recordFailedLoginAttempt(
	accountRateLimitKey: string,
): Promise<void> {
	const now = new Date();

	const state = await recordRateLimitFailure({
		namespace: LOGIN_RATE_LIMIT_NAMESPACE,
		key: accountRateLimitKey,
		subject: accountRateLimitKey,
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
	accountRateLimitKey: string,
): Promise<void> {
	await clearRateLimitState(LOGIN_RATE_LIMIT_NAMESPACE, accountRateLimitKey);
}

function generateRecoveryVerificationCode(): string {
	return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateSignupVerificationCode(): string {
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

export async function createSignupVerification(input: {
	email: string;
	invitationToken?: string;
}): Promise<string> {
	const normalizedEmail = normalizeEmail(input.email);
	const invitationToken = input.invitationToken ?? null;
	const now = new Date();
	const code = generateSignupVerificationCode();

	await db
		.update(signupVerification)
		.set({ usedAt: now })
		.where(
			and(
				eq(signupVerification.email, normalizedEmail),
				matchOptionalInvitationToken(invitationToken),
				isNull(signupVerification.usedAt),
			),
		);

	await db.insert(signupVerification).values({
		id: nanoid(),
		email: normalizedEmail,
		invitationToken,
		code,
		expiresAt: new Date(now.getTime() + SIGNUP_VERIFICATION_DURATION_MS),
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

export async function consumeSignupVerificationCode(input: {
	email: string;
	code: string;
	invitationToken?: string;
}): Promise<boolean> {
	const normalizedEmail = normalizeEmail(input.email);
	const invitationToken = input.invitationToken ?? null;
	const now = new Date();

	const validVerification = await db.query.signupVerification.findFirst({
		where: (record, { and: andFn, eq: eqFn, gt: gtFn, isNull: isNullFn }) =>
			andFn(
				eqFn(record.email, normalizedEmail),
				invitationToken === null
					? isNullFn(record.invitationToken)
					: eqFn(record.invitationToken, invitationToken),
				eqFn(record.code, input.code),
				gtFn(record.expiresAt, now),
				isNullFn(record.usedAt),
			),
		orderBy: (record, { desc: descFn }) => [descFn(record.createdAt)],
	});

	if (validVerification) {
		if (validVerification.attempts >= validVerification.maxAttempts) {
			return false;
		}

		await db
			.update(signupVerification)
			.set({
				attempts: validVerification.attempts + 1,
				usedAt: now,
			})
			.where(eq(signupVerification.id, validVerification.id));

		return true;
	}

	const activeVerification = await db.query.signupVerification.findFirst({
		where: (record, { and: andFn, eq: eqFn, gt: gtFn, isNull: isNullFn }) =>
			andFn(
				eqFn(record.email, normalizedEmail),
				invitationToken === null
					? isNullFn(record.invitationToken)
					: eqFn(record.invitationToken, invitationToken),
				gtFn(record.expiresAt, now),
				isNullFn(record.usedAt),
			),
		orderBy: (record, { desc: descFn }) => [descFn(record.createdAt)],
	});

	if (activeVerification) {
		const nextAttempts = activeVerification.attempts + 1;
		await db
			.update(signupVerification)
			.set({
				attempts: nextAttempts,
				...(nextAttempts >= activeVerification.maxAttempts
					? { usedAt: now }
					: {}),
			})
			.where(eq(signupVerification.id, activeVerification.id));
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
	const id = getScopedRateLimitId(email, ipAddress);
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
	const id = getScopedRateLimitId(normalizedEmail, ipAddress?.trim() || null);
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
	const id = getScopedRateLimitId(email, ipAddress?.trim() || null);
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
export async function getUserSessions(
	userId: string,
	currentSessionId?: string,
) {
	const activeSessions = await db
		.select()
		.from(session)
		.where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
		.orderBy(session.lastActiveAt);

	const logicalSessions: SessionRow[] = [];
	const groupedWebSessions = new Map<string, SessionRow[]>();

	for (const activeSession of activeSessions) {
		if (isGroupedWebSession(activeSession)) {
			const group = groupedWebSessions.get(activeSession.clientId) ?? [];
			group.push(activeSession);
			groupedWebSessions.set(activeSession.clientId, group);
			continue;
		}

		logicalSessions.push(activeSession);
	}

	for (const group of groupedWebSessions.values()) {
		const representative =
			(currentSessionId
				? group.find((candidate) => candidate.id === currentSessionId)
				: undefined) ?? [...group].sort(compareSessionRecency)[0];

		if (representative) {
			logicalSessions.push(representative);
		}
	}

	logicalSessions.sort(compareSessionRecency);

	return logicalSessions.map((s) => ({
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
): Promise<string[]> {
	const existingSession = await getOwnedSession(sessionId, userId);

	if (!existingSession) {
		return [];
	}

	if (isGroupedWebSession(existingSession)) {
		const groupedSessions = await db
			.select({ id: session.id })
			.from(session)
			.where(
				and(
					eq(session.userId, userId),
					eq(session.platform, existingSession.platform),
					eq(session.clientId, existingSession.clientId),
				),
			);

		await db
			.delete(session)
			.where(
				and(
					eq(session.userId, userId),
					eq(session.platform, existingSession.platform),
					eq(session.clientId, existingSession.clientId),
				),
			);

		return groupedSessions.map((groupedSession) => groupedSession.id);
	}

	await db
		.delete(session)
		.where(and(eq(session.id, sessionId), eq(session.userId, userId)));

	return [existingSession.id];
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
	const existingSession = await getOwnedSession(sessionId, userId);

	if (!existingSession) {
		return;
	}

	if (isGroupedWebSession(existingSession)) {
		await db
			.update(session)
			.set({ deviceName })
			.where(
				and(
					eq(session.userId, userId),
					eq(session.platform, existingSession.platform),
					eq(session.clientId, existingSession.clientId),
					gt(session.expiresAt, new Date()),
				),
			);
		return;
	}

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

export {
	incrementRateLimitWindow,
	RATE_LIMIT_NAMESPACE,
	startOfLocalDay,
} from "./rate-limit";
