/**
 * Test utilities for tRPC integration tests
 * Provides helpers for creating test contexts, mock data, and database operations
 *
 * Note: Tests use a separate database (bittery_test) to avoid affecting development data.
 * Environment variables are loaded from apps/server/.env.test via bun's --env-file flag.
 * Run `pnpm run db:test:setup` to create and migrate the test database.
 */
import { session, user } from "@bittery/db/schema/auth";
import { shareLink } from "@bittery/db/schema/sharing";
import { syncEvent } from "@bittery/db/schema/sync";
import { team, teamInvitation } from "@bittery/db/schema/team";
import { item, vault, vaultKey } from "@bittery/db/schema/vault";
import type { Context } from "../context";
export declare function generateTestEmail(): string;
export declare function generateTestUserId(): string;
export declare function generateTestSessionId(): string;
/**
 * Create a mock context for testing
 */
export declare function createTestContext(sessionData?: {
    userId: string;
    sessionId: string;
    expiresAt: Date;
    platform?: string | null;
} | null, deviceOverrides?: Partial<Context["device"]>): Context;
/**
 * Create a mock authenticated context
 */
export declare function createAuthenticatedContext(userId: string, _email: string, sessionId?: string, deviceOverrides?: Partial<Context["device"]>): Context;
/**
 * Create a mock public (unauthenticated) context
 */
export declare function createPublicContext(): Context;
export declare const mockSrpData: {
    srpSalt: string;
    srpVerifier: string;
    publicKey: string;
    encryptedPrivateKey: string;
    encryptedVaultKey: string;
    secretKeyHint: string;
};
export interface TestAuthCryptoData {
    accountPassword: string;
    authPassword: string;
    secretKey: string;
    secretKeyHint: string;
    recoveryKeyHint: string;
    srpSalt: string;
    srpVerifier: string;
    publicKey: string;
    encryptedPrivateKey: string;
    encryptedMasterKey: string;
    encryptedVaultKey: string;
}
export declare function generateTestAuthCryptoData(params: {
    email: string;
    accountPassword?: string;
    secretKey?: string;
    recoveryKey?: string;
}): Promise<TestAuthCryptoData>;
export declare function generateTestSrpClientEphemeral(): Promise<{
    clientPublicKey: string;
    clientSecret: string;
}>;
export declare function deriveTestSrpClientProof(params: {
    clientSecret: string;
    salt: string;
    serverPublicKey: string;
    authPassword: string;
}): Promise<{
    clientProof: string;
}>;
export declare const mockItemData: {
    encryptedData: string;
    encryptionIv: string;
    encryptionAlgorithm: string;
};
export declare const mockShareData: {
    encryptedItemData: string;
    encryptionIv: string;
    encryptedShareKey: string;
    shareKeyIv: string;
};
/**
 * Create a test user directly in the database
 */
export declare function createTestUser(overrides?: Partial<typeof user.$inferInsert>): Promise<{
    userId: string;
    email: string;
}>;
/**
 * Create a test session for a user
 */
export declare function createTestSession(userId: string, overrides?: Partial<typeof session.$inferInsert>): Promise<string>;
/**
 * Create a test vault for a user
 */
export declare function createTestVault(userId: string, overrides?: Partial<typeof vault.$inferInsert>, vaultKeyOverrides?: Partial<typeof vaultKey.$inferInsert>): Promise<string>;
/**
 * Create a test item in a vault
 */
export declare function createTestItem(vaultId: string, userId: string, overrides?: Partial<typeof item.$inferInsert>): Promise<string>;
/**
 * Create a test team
 * Sets user.teamId and user.role (one-to-one relationship)
 */
export declare function createTestTeam(ownerId: string, overrides?: Partial<typeof team.$inferInsert>): Promise<string>;
/**
 * Add a member to a team
 * Sets user.teamId and user.role (one-to-one relationship)
 */
export declare function addTeamMember(teamId: string, userId: string, role?: "owner" | "admin" | "member"): Promise<void>;
/**
 * Add a member to a vault
 */
export declare function addVaultMember(vaultId: string, userId: string, role?: "owner" | "admin" | "member" | "read-only"): Promise<string>;
/**
 * Create a test team invitation
 */
export declare function createTestInvitation(teamId: string, invitedById: string, email: string, overrides?: Partial<typeof teamInvitation.$inferInsert>): Promise<{
    invitationId: string;
    token: string;
}>;
/**
 * Create a test share link
 */
export declare function createTestShareLink(itemId: string, createdById: string, overrides?: Partial<typeof shareLink.$inferInsert>): Promise<{
    shareLinkId: string;
    token: string;
}>;
/**
 * Add allowed email to a share link
 */
export declare function addShareLinkAllowedEmail(shareLinkId: string, email: string, verified?: boolean): Promise<string>;
/**
 * Clean up test data - should be called after each test
 */
export declare function cleanupTestData(userIds?: string[]): Promise<void>;
/**
 * Get user from database
 */
export declare function getUser(userId: string): Promise<{
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    secretKeyHint: string | null;
    encryptedMasterKey: string | null;
    recoveryKeyHint: string | null;
    srpSalt: string;
    srpVerifier: string;
    publicKey: string;
    encryptedPrivateKey: string;
    teamId: string | null;
    role: "owner" | "admin" | "member";
    createdAt: Date;
    updatedAt: Date;
} | undefined>;
/**
 * Get vault from database
 */
export declare function getVault(vaultId: string): Promise<{
    id: string;
    name: string;
    teamId: string | null;
    createdAt: Date;
    updatedAt: Date;
    type: "personal" | "team";
    imageKey: string | null;
    icon: string | null;
    createdById: string;
    keyVersion: number;
} | undefined>;
/**
 * Get item from database
 */
export declare function getItem(itemId: string): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    vaultId: string;
    category: "identity" | "login" | "secure-note" | "credit-card" | "totp";
    favorite: boolean;
    encryptedData: string;
    encryptionIv: string;
    encryptionAlgorithm: string;
    version: number;
    lastModifiedBy: string | null;
    deletedAt: Date | null;
} | undefined>;
/**
 * Get team from database
 */
export declare function getTeam(teamId: string): Promise<{
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    ownerId: string;
    type: "personal" | "family" | "organization";
    memberLimit: number | null;
    billingPlan: "personal" | "family" | "free" | "team";
    billingStatus: "none" | "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid";
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripeSubscriptionItemId: string | null;
    stripePriceId: string | null;
    seatsPurchased: number | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    imageKey: string | null;
} | undefined>;
/**
 * Get session from database
 */
export declare function getSession(sessionId: string): Promise<{
    id: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
    deviceName: string | null;
    platform: string | null;
    deviceInfo: string | null;
    browserName: string | null;
    browserVersion: string | null;
    osName: string | null;
    osVersion: string | null;
    lastActiveAt: Date;
    userId: string;
} | undefined>;
/**
 * Get vault key for a user
 */
export declare function getVaultKey(vaultId: string, userId: string): Promise<{
    id: string;
    role: "owner" | "admin" | "member" | "read-only";
    createdAt: Date;
    userId: string;
    vaultId: string;
    encryptedVaultKey: string;
} | undefined>;
/**
 * Get team member by checking user.teamId (one-to-one relationship)
 */
export declare function getTeamMember(teamId: string, userId: string): Promise<{
    role: "owner" | "admin" | "member";
    userId: string;
} | undefined>;
/**
 * Count items in a vault
 */
export declare function countVaultItems(vaultId: string): Promise<number>;
/**
 * Count team members by checking user.teamId (one-to-one relationship)
 */
export declare function countTeamMembers(teamId: string): Promise<number>;
/**
 * Truncate all tables — fast cleanup for test isolation.
 * Replaces the per-user cleanupTestData() with a single TRUNCATE CASCADE.
 */
export declare function truncateAll(): Promise<void>;
/**
 * Create a test sync event directly in the database
 */
export declare function createTestSyncEvent(vaultId: string, userId: string, overrides?: Partial<typeof syncEvent.$inferInsert>): Promise<string>;
/**
 * Get sync event from database
 */
export declare function getSyncEvent(eventId: string): Promise<{
    id: string;
    createdAt: Date;
    userId: string;
    entityType: "vault" | "vault_key" | "item" | "vault_member";
    entityId: string;
    metadata: string | null;
    eventType: "item_created" | "item_updated" | "item_deleted" | "item_restored" | "item_permanently_deleted" | "item_moved" | "vault_created" | "vault_updated" | "vault_deleted" | "vault_access_revoked" | "vault_member_added" | "vault_member_removed" | "vault_key_rotated";
    vaultId: string | null;
    version: number;
    seq: number;
    clientId: string | null;
} | undefined>;
/**
 * Get sync event acks for a user/client
 */
export declare function getSyncEventAcks(userId: string, clientId: string): Promise<{
    id: string;
    userId: string;
    eventId: string;
    clientId: string;
    acknowledgedAt: Date;
}[]>;
/**
 * Create an authenticated caller for a router in a single call.
 * Handles user creation, session creation, and caller setup.
 */
export declare function setup<T extends {
    createCaller: (ctx: Context) => any;
}>(router: T, overrides?: Partial<typeof user.$inferInsert>): Promise<{
    userId: string;
    email: string;
    sessionId: string;
    caller: ReturnType<T["createCaller"]>;
}>;
/**
 * Create a vault with N items in one call.
 */
export declare function setupVaultWithItems(userId: string, itemCount?: number, vaultOverrides?: Partial<typeof vault.$inferInsert>, itemOverrides?: Partial<typeof item.$inferInsert>): Promise<{
    vaultId: string;
    itemIds: string[];
}>;
/**
 * Create a complete share link setup: vault → item → share link.
 */
export declare function setupShareLink(userId: string, opts?: {
    vaultOverrides?: Partial<typeof vault.$inferInsert>;
    itemOverrides?: Partial<typeof item.$inferInsert>;
    shareLinkOverrides?: Partial<typeof shareLink.$inferInsert>;
}): Promise<{
    vaultId: string;
    itemId: string;
    shareLinkId: string;
    token: string;
}>;
/**
 * Create a team with the owner and additional members (creates new users for each member).
 */
export declare function setupTeamWithMembers(ownerId: string, members?: Array<{
    role?: "admin" | "member";
    overrides?: Partial<typeof user.$inferInsert>;
}>, teamOverrides?: Partial<typeof team.$inferInsert>): Promise<{
    teamId: string;
    members: {
        userId: string;
        email: string;
        role: "admin" | "member";
    }[];
}>;
