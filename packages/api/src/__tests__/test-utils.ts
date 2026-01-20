/**
 * Test utilities for tRPC integration tests
 * Provides helpers for creating test contexts, mock data, and database operations
 *
 * Note: Environment variables are loaded via bun's --env-file flag in the test scripts.
 * See package.json for the test command configuration.
 */

import { db } from "@bittery/db";
import { session, user } from "@bittery/db/schema/auth";
import {
	shareAccessLog,
	shareEmailVerification,
	shareLink,
	shareLinkAllowedEmail,
	shareLinkRateLimit,
} from "@bittery/db/schema/sharing";
import { syncEvent, syncEventAck } from "@bittery/db/schema/sync";
import { team, teamInvitation, teamMember } from "@bittery/db/schema/team";
import {
	item,
	vault,
	vaultKey,
	vaultKeyRotation,
} from "@bittery/db/schema/vault";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Context } from "../context";

// Test data generation helpers
export function generateTestEmail(): string {
	return `test-${nanoid(8)}@example.com`.toLowerCase();
}

export function generateTestUserId(): string {
	return nanoid();
}

/**
 * Create a mock context for testing
 */
export function createTestContext(
	sessionData?: { userId: string; email: string; sessionId: string } | null,
): Context {
	return {
		session: sessionData || null,
		device: {
			userAgent: "Test/1.0 (Testing)",
			ipAddress: "127.0.0.1",
		},
	};
}

/**
 * Create a mock authenticated context
 */
export function createAuthenticatedContext(
	userId: string,
	email: string,
	sessionId?: string,
): Context {
	return createTestContext({
		userId,
		email,
		sessionId: sessionId || nanoid(),
	});
}

/**
 * Create a mock public (unauthenticated) context
 */
export function createPublicContext(): Context {
	return createTestContext(null);
}

// Mock SRP registration data - these are realistic but non-functional test values
export const mockSrpData = {
	// SRP salt (32 bytes hex encoded)
	srpSalt: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
	// SRP verifier (large hex string representing g^x mod N)
	srpVerifier:
		"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
		"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
		"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" +
		"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
	// RSA public key (PEM format - test key)
	publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAn4w8PGUjCHPJJ4a7DTAQ
rVVMhsBbY9JE3xtFxTyWlz5BWuvQfq5KjQPd8qGNUH3oGdLxnKuS6Rp9KJJp1M9l
z6pMEqCBKxJBPLJJpON7vFYYQBmF9GUi5PXYY6fzj7L2P8nYvGxEHT5UqY6Y9H5g
XGS5RKBLXMDY4WRMH1JLnDHTHGF5N5JvJJ2hJJ3PLZZP5JJJ5JJJ5JJJ5JJJ5JJJ
5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ
5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ5JJJ
xwIDAQAB
-----END PUBLIC KEY-----`,
	// Encrypted private key (base64 encoded - test data)
	encryptedPrivateKey:
		"YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkwYWJjZGVmZ2hpamts",
	// Encrypted vault key (base64 encoded - test data)
	encryptedVaultKey: "dGVzdC1lbmNyeXB0ZWQtdmF1bHQta2V5LWRhdGEtZm9yLXRlc3Rpbmc=",
	// Secret key hint
	secretKeyHint: "A3-TESTKEY",
};

// Mock item data for testing
export const mockItemData = {
	encryptedData: "dGVzdC1lbmNyeXB0ZWQtaXRlbS1kYXRhLWZvci10ZXN0aW5nLXB1cnBvc2Vz",
	encryptionIv: "YWJjZGVmZ2hpamts",
	encryptionAlgorithm: "AES-GCM",
};

// Mock share data for testing
export const mockShareData = {
	encryptedItemData: "dGVzdC1zaGFyZS1lbmNyeXB0ZWQtaXRlbS1kYXRh",
	encryptionIv: "c2hhcmUtaXY=",
	encryptedShareKey: "dGVzdC1zaGFyZS1rZXk=",
	shareKeyIv: "c2hhcmUta2V5LWl2",
};

/**
 * Create a test user directly in the database
 */
export async function createTestUser(
	overrides: Partial<typeof user.$inferInsert> = {},
) {
	const userId = overrides.id || nanoid();
	const email = (overrides.email || generateTestEmail()).toLowerCase();

	await db.insert(user).values({
		id: userId,
		name: overrides.name || "Test User",
		email,
		emailVerified: overrides.emailVerified ?? false,
		secretKeyHint: overrides.secretKeyHint || mockSrpData.secretKeyHint,
		srpSalt: overrides.srpSalt || mockSrpData.srpSalt,
		srpVerifier: overrides.srpVerifier || mockSrpData.srpVerifier,
		publicKey: overrides.publicKey || mockSrpData.publicKey,
		encryptedPrivateKey:
			overrides.encryptedPrivateKey || mockSrpData.encryptedPrivateKey,
	});

	return { userId, email };
}

/**
 * Create a test session for a user
 */
export async function createTestSession(
	userId: string,
	overrides: Partial<typeof session.$inferInsert> = {},
) {
	const sessionId = overrides.id || nanoid();
	const expiresAt =
		overrides.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

	await db.insert(session).values({
		id: sessionId,
		userId,
		token: overrides.token || nanoid(32),
		expiresAt,
		deviceName: overrides.deviceName || "Test Device",
		platform: overrides.platform || "web",
		browserName: overrides.browserName || "Chrome",
		browserVersion: overrides.browserVersion || "120.0",
		osName: overrides.osName || "macOS",
		osVersion: overrides.osVersion || "14.0",
		userAgent: overrides.userAgent || "Test/1.0",
		ipAddress: overrides.ipAddress || "127.0.0.1",
		lastActiveAt: overrides.lastActiveAt || new Date(),
	});

	return sessionId;
}

/**
 * Create a test vault for a user
 */
export async function createTestVault(
	userId: string,
	overrides: Partial<typeof vault.$inferInsert> = {},
	vaultKeyOverrides: Partial<typeof vaultKey.$inferInsert> = {},
) {
	const vaultId = overrides.id || nanoid();

	await db.insert(vault).values({
		id: vaultId,
		name: overrides.name || "Test Vault",
		type: overrides.type || "personal",
		icon: overrides.icon || "lock",
		createdById: userId,
		teamId: overrides.teamId || null,
		keyVersion: overrides.keyVersion || 1,
	});

	// Create vault key for the user
	await db.insert(vaultKey).values({
		id: vaultKeyOverrides.id || nanoid(),
		vaultId,
		userId,
		encryptedVaultKey:
			vaultKeyOverrides.encryptedVaultKey || mockSrpData.encryptedVaultKey,
		role: vaultKeyOverrides.role || "owner",
	});

	return vaultId;
}

/**
 * Create a test item in a vault
 */
export async function createTestItem(
	vaultId: string,
	userId: string,
	overrides: Partial<typeof item.$inferInsert> = {},
) {
	const itemId = overrides.id || nanoid();

	await db.insert(item).values({
		id: itemId,
		vaultId,
		category: overrides.category || "login",
		favorite: overrides.favorite ?? false,
		encryptedData: overrides.encryptedData || mockItemData.encryptedData,
		encryptionIv: overrides.encryptionIv || mockItemData.encryptionIv,
		encryptionAlgorithm:
			overrides.encryptionAlgorithm || mockItemData.encryptionAlgorithm,
		version: overrides.version || 1,
		lastModifiedBy: userId,
		deletedAt: overrides.deletedAt || null,
	});

	return itemId;
}

/**
 * Create a test team
 */
export async function createTestTeam(
	ownerId: string,
	overrides: Partial<typeof team.$inferInsert> = {},
) {
	const teamId = overrides.id || nanoid();

	await db.insert(team).values({
		id: teamId,
		name: overrides.name || "Test Team",
		ownerId,
	});

	// Add owner as team member
	await db.insert(teamMember).values({
		id: nanoid(),
		teamId,
		userId: ownerId,
		role: "owner",
		joinedAt: new Date(),
	});

	return teamId;
}

/**
 * Add a member to a team
 */
export async function addTeamMember(
	teamId: string,
	userId: string,
	role: "owner" | "admin" | "member" = "member",
) {
	const memberId = nanoid();

	await db.insert(teamMember).values({
		id: memberId,
		teamId,
		userId,
		role,
		joinedAt: new Date(),
	});

	return memberId;
}

/**
 * Add a member to a vault
 */
export async function addVaultMember(
	vaultId: string,
	userId: string,
	role: "owner" | "admin" | "member" | "read-only" = "member",
) {
	const keyId = nanoid();

	await db.insert(vaultKey).values({
		id: keyId,
		vaultId,
		userId,
		encryptedVaultKey: mockSrpData.encryptedVaultKey,
		role,
	});

	return keyId;
}

/**
 * Create a test team invitation
 */
export async function createTestInvitation(
	teamId: string,
	invitedById: string,
	email: string,
	overrides: Partial<typeof teamInvitation.$inferInsert> = {},
) {
	const invitationId = overrides.id || nanoid();
	const token = overrides.token || nanoid(32);
	const expiresAt =
		overrides.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

	await db.insert(teamInvitation).values({
		id: invitationId,
		teamId,
		email: email.toLowerCase(),
		role: overrides.role || "member",
		invitedById,
		token,
		expiresAt,
		status: overrides.status || "pending",
		pendingVaultKeys: overrides.pendingVaultKeys || null,
	});

	return { invitationId, token };
}

/**
 * Create a test share link
 */
export async function createTestShareLink(
	itemId: string,
	createdById: string,
	overrides: Partial<typeof shareLink.$inferInsert> = {},
) {
	const shareLinkId = overrides.id || nanoid();
	const token = overrides.token || nanoid(32);
	const expiresAt =
		overrides.expiresAt || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

	await db.insert(shareLink).values({
		id: shareLinkId,
		itemId,
		createdById,
		token,
		accessMode: overrides.accessMode || "anyone",
		isOneTimeUse: overrides.isOneTimeUse ?? false,
		encryptedItemData:
			overrides.encryptedItemData || mockShareData.encryptedItemData,
		encryptionIv: overrides.encryptionIv || mockShareData.encryptionIv,
		encryptedShareKey:
			overrides.encryptedShareKey || mockShareData.encryptedShareKey,
		shareKeyIv: overrides.shareKeyIv || mockShareData.shareKeyIv,
		maxAccessCount: overrides.maxAccessCount || null,
		accessCount: overrides.accessCount || 0,
		expiresAt,
		status: overrides.status || "active",
	});

	return { shareLinkId, token };
}

/**
 * Add allowed email to a share link
 */
export async function addShareLinkAllowedEmail(
	shareLinkId: string,
	email: string,
	verified = false,
) {
	const emailId = nanoid();

	await db.insert(shareLinkAllowedEmail).values({
		id: emailId,
		shareLinkId,
		email: email.toLowerCase(),
		verified,
		verifiedAt: verified ? new Date() : null,
	});

	return emailId;
}

/**
 * Clean up test data - should be called after each test
 */
export async function cleanupTestData(userIds: string[] = []) {
	// Clean up in reverse dependency order
	for (const userId of userIds) {
		// Clean up share-related data
		const userShareLinks = await db.query.shareLink.findMany({
			where: (sl, { eq }) => eq(sl.createdById, userId),
		});

		for (const link of userShareLinks) {
			await db
				.delete(shareAccessLog)
				.where(eq(shareAccessLog.shareLinkId, link.id));
			await db
				.delete(shareEmailVerification)
				.where(eq(shareEmailVerification.shareLinkId, link.id));
			await db
				.delete(shareLinkAllowedEmail)
				.where(eq(shareLinkAllowedEmail.shareLinkId, link.id));
		}

		await db.delete(shareLink).where(eq(shareLink.createdById, userId));
		await db
			.delete(shareLinkRateLimit)
			.where(eq(shareLinkRateLimit.userId, userId));

		// Clean up sync events
		await db.delete(syncEventAck).where(eq(syncEventAck.userId, userId));

		// Clean up vault keys, items, and vaults
		await db.delete(vaultKey).where(eq(vaultKey.userId, userId));
		const userVaults = await db.query.vault.findMany({
			where: (v, { eq }) => eq(v.createdById, userId),
		});

		for (const v of userVaults) {
			await db.delete(item).where(eq(item.vaultId, v.id));
			await db.delete(vaultKey).where(eq(vaultKey.vaultId, v.id));
			await db
				.delete(vaultKeyRotation)
				.where(eq(vaultKeyRotation.vaultId, v.id));
			await db.delete(syncEvent).where(eq(syncEvent.vaultId, v.id));
		}

		await db.delete(vault).where(eq(vault.createdById, userId));

		// Clean up team data
		await db.delete(teamMember).where(eq(teamMember.userId, userId));
		await db
			.delete(teamInvitation)
			.where(eq(teamInvitation.invitedById, userId));
		const userTeams = await db.query.team.findMany({
			where: (t, { eq }) => eq(t.ownerId, userId),
		});

		for (const t of userTeams) {
			await db.delete(teamInvitation).where(eq(teamInvitation.teamId, t.id));
			await db.delete(teamMember).where(eq(teamMember.teamId, t.id));
		}

		await db.delete(team).where(eq(team.ownerId, userId));

		// Clean up sessions and user
		await db.delete(session).where(eq(session.userId, userId));
		await db.delete(user).where(eq(user.id, userId));
	}
}

/**
 * Get user from database
 */
export async function getUser(userId: string) {
	return db.query.user.findFirst({
		where: (u, { eq }) => eq(u.id, userId),
	});
}

/**
 * Get vault from database
 */
export async function getVault(vaultId: string) {
	return db.query.vault.findFirst({
		where: (v, { eq }) => eq(v.id, vaultId),
	});
}

/**
 * Get item from database
 */
export async function getItem(itemId: string) {
	return db.query.item.findFirst({
		where: (i, { eq }) => eq(i.id, itemId),
	});
}

/**
 * Get team from database
 */
export async function getTeam(teamId: string) {
	return db.query.team.findFirst({
		where: (t, { eq }) => eq(t.id, teamId),
	});
}

/**
 * Get session from database
 */
export async function getSession(sessionId: string) {
	return db.query.session.findFirst({
		where: (s, { eq }) => eq(s.id, sessionId),
	});
}

/**
 * Get vault key for a user
 */
export async function getVaultKey(vaultId: string, userId: string) {
	return db.query.vaultKey.findFirst({
		where: (vk, { and, eq }) =>
			and(eq(vk.vaultId, vaultId), eq(vk.userId, userId)),
	});
}

/**
 * Get team member
 */
export async function getTeamMember(teamId: string, userId: string) {
	return db.query.teamMember.findFirst({
		where: (tm, { and, eq }) =>
			and(eq(tm.teamId, teamId), eq(tm.userId, userId)),
	});
}

/**
 * Count items in a vault
 */
export async function countVaultItems(vaultId: string) {
	const items = await db.query.item.findMany({
		where: (i, { eq }) => eq(i.vaultId, vaultId),
	});
	return items.length;
}

/**
 * Count team members
 */
export async function countTeamMembers(teamId: string) {
	const members = await db.query.teamMember.findMany({
		where: (tm, { eq }) => eq(tm.teamId, teamId),
	});
	return members.length;
}
