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
	sessionId?: string;
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
	teamAvatarUrl?: string | null;
	secretKeyHint: string;
	addedAt: number;
	lastActiveAt: number;
	biometricEnabled: boolean;
}

/**
 * Active account configuration
 * - { type: "single", email: string } - A specific account is active
 * - { type: "all" } - All unlocked accounts are active (multi-account mode)
 * - null - No account is active (logged out)
 */
export type ActiveAccount =
	| { type: "single"; email: string }
	| { type: "all" }
	| null;

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

/**
 * Convert biometric error type to user-friendly message
 */
export function getBiometricErrorMessage(error: BiometricErrorType): string {
	switch (error) {
		case "not_available":
			return "This device does not support biometric authentication.";
		case "not_enrolled":
			return "No biometrics are set up on this device. Please configure Face ID or Touch ID in your device settings.";
		case "not_enabled":
			return "Biometric unlock is not enabled for this account. You can enable it in Settings.";
		case "authentication_failed":
			return "Biometric authentication failed. Please try again or use your password.";
		case "user_cancelled":
			return "Authentication was cancelled.";
		case "lockout":
			return "Too many failed attempts. Please use your master password to unlock.";
		case "master_password_required":
			return "For security, please enter your master password. This is required every 30 days.";
		case "session_expired":
			return "Your session has expired. Please log in with your credentials.";
		default:
			return "An error occurred during authentication. Please try again.";
	}
}
