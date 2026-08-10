/**
 * Types for client-side storage adapters
 */

import type { EncryptedData } from "@bittery/types";

/**
 * Vault key data stored locally
 */
export interface VaultKeyData {
	vaultId: string;
	vaultName: string;
	vaultType: "personal" | "team";
	vaultIcon?: string | null;
	vaultImageUrl?: string | null;
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

/**
 * Cached travel mode configuration mirrored from the server.
 */
export interface TravelModeConfig {
	enabled: boolean;
	hiddenVaultIds: string[];
	enabledAt?: number | null;
	updatedAt?: number;
}

/**
 * How a caller may express a session expiry.
 *
 * An ISO string or `Date` is an absolute instant; a number is absolute when it looks like
 * a millisecond epoch and a relative duration otherwise. `AccountStore` owns the single
 * rule that resolves this into a timestamp — see `resolveStoredSessionExpiryTimestamp`
 * there. The type lives here because it is part of the vocabulary, not of the resolution.
 */
export type SessionExpiryInput = string | Date | number;

/**
 * Encrypted session data persisted to storage
 */
export interface StoredSessionData {
	encryptedMasterUnlockKey: EncryptedData;
	email: string;
	userId: string;
	sessionId?: string;
	expiresAt: number; // timestamp
	serverExpiresAt?: number; // timestamp
	createdAt: number; // timestamp
	biometricEnabled?: boolean;
	lastMasterPasswordEntry?: number; // timestamp of last master password authentication
}

/**
 * Account metadata for multi-account support.
 * accountId is the stable local primary key; email is display/login metadata only.
 */
export interface AccountMetadata {
	accountId: string;
	email: string;
	userId: string;
	name: string;
	serverUrl?: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
	secretKeyHint: string;
	addedAt: number;
	lastActiveAt: number;
	biometricEnabled: boolean;
	/** Explicit consent for this account to send credentials over remote HTTP. */
	insecureTransportConfirmed?: boolean;
}

/**
 * The active account pointer: an accountId, or `null` when logged out.
 *
 * Named rather than a bare `string | null` because an accountId is one of several
 * bare-string identities in flight (email, userId, serverUrl, vaultId) and confusing
 * them silently crosses accounts.
 */
export type ActiveAccountId = string | null;

/**
 * Platform types
 */
export type Platform = "web" | "extension" | "desktop" | "mobile";

/**
 * Default session expiry: 14 days (in milliseconds)
 */
export const DEFAULT_SESSION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Default auto-lock timeout: 10 minutes (in milliseconds)
 * -1 means never auto-lock
 */
export const DEFAULT_AUTO_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Biometric authentication grace period: 10 minutes (in milliseconds)
 */
export const BIOMETRIC_GRACE_PERIOD_MS = 10 * 60 * 1000;

/**
 * Periodic master password re-entry: 30 days (in milliseconds)
 */
export const MASTER_PASSWORD_REENTRY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Error types for biometric authentication
 */
export type BiometricErrorType =
	| "not_available" // Device doesn't have biometric hardware
	| "not_enrolled" // No biometrics enrolled on device
	| "not_enabled" // User hasn't enabled biometric for this account
	| "authentication_failed" // Biometric didn't match
	| "user_cancelled" // User cancelled the prompt
	| "lockout" // Too many failed attempts
	| "master_password_required" // Periodic re-entry required
	| "session_expired" // Session has expired
	| "account_not_found" // Requested account does not exist
	| "unknown"; // Unknown error

/**
 * Biometric authentication result
 */
export interface BiometricAuthResult {
	success: boolean;
	error?: BiometricErrorType;
	/**
	 * Diagnostic detail, in English, for logs and bug reports — **not** display copy.
	 * The UI branches on `error` and renders its own translated message.
	 */
	message?: string;
	/**
	 * Structured detail for `master_password_required`: how often re-entry is required.
	 *
	 * Storage publishes the number and never the sentence. Formatting "every 30 days" is
	 * user-facing copy, and `CLAUDE.md` forbids storage from producing any — the UI owns
	 * the plural rules and the translation.
	 */
	masterPasswordReentryPeriodMs?: number;
}
