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
 * Encrypted session data persisted to storage
 */
export interface StoredSessionData {
	encryptedMasterUnlockKey: EncryptedData;
	email: string;
	userId: string;
	expiresAt: number; // timestamp
	createdAt: number; // timestamp
	biometricEnabled?: boolean;
	lastMasterPasswordEntry?: number; // timestamp of last master password authentication
}

/**
 * Account metadata for multi-account support
 */
export interface AccountMetadata {
	email: string;
	userId: string;
	name: string;
	teamName?: string;
	secretKeyHint: string;
	addedAt: number;
	lastActiveAt: number;
	biometricEnabled: boolean;
}

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
	| "unknown"; // Unknown error

/**
 * Biometric authentication result
 */
export interface BiometricAuthResult {
	success: boolean;
	error?: BiometricErrorType;
	message?: string;
}
