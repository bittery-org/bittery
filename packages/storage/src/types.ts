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
}

/**
 * Active account configuration
 * - { type: "single", accountId: string } - A specific account is active
 * - null - No account is active (logged out)
 */
export type ActiveAccount = { type: "single"; accountId: string } | null;

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
	message?: string;
}
