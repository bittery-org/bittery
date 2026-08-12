import { NativeModule, requireNativeModule } from "expo";

import type {
	CredentialProviderModuleEvents,
	EscrowMukParams,
	PendingPasskeyMutation,
} from "./CredentialProvider.types";

declare class CredentialProviderModule extends NativeModule<CredentialProviderModuleEvents> {
	// ============================================
	// Vault State Management
	// ============================================

	/**
	 * Set the Master Unlock Key from React Native after successful login/unlock.
	 * This makes the MUK available to the CredentialProviderService for decryption.
	 *
	 * @param mukBase64 Base64-encoded Master Unlock Key (32 bytes = 44 chars)
	 * @returns true if successful
	 */
	setMasterUnlockKey(
		mukBase64: string,
		userId?: string,
		autoLockTimeoutMs?: number,
	): boolean;

	/**
	 * Update native MUK auto-lock timeout for a user.
	 * Applies immediately to currently persisted native MUK state.
	 */
	setMukAutoLockTimeout(timeoutMs: number, userId?: string): boolean;

	/**
	 * Clear the Master Unlock Key (on logout or auto-lock).
	 * @returns true if successful
	 */
	clearMasterUnlockKey(userId?: string): boolean;

	/**
	 * Clear all Master Unlock Keys (on logout or when locking all accounts).
	 * @returns true if successful
	 */
	clearAllMasterUnlockKeys(): boolean;

	/**
	 * Check if the vault is currently unlocked (MUK available).
	 */
	isVaultUnlocked(userId?: string): boolean;

	/**
	 * Get the MUK as Base64 string (for debugging/verification only).
	 * WARNING: Only use in development builds.
	 */
	getMasterUnlockKeyBase64(userId?: string): string | null;

	// ============================================
	// MUK Escrow Management
	// ============================================

	/**
	 * Escrow the MUK with biometric protection after password unlock.
	 * This enables future biometric-only unlocks without re-entering password.
	 */
	escrowMukWithBiometric(params: EscrowMukParams): Promise<boolean>;

	/**
	 * Retrieve the escrowed MUK using biometric authentication.
	 * This unlocks the vault without requiring password entry.
	 */
	retrieveEscrowedMuk(): Promise<boolean>;

	/**
	 * Check if there is a valid (non-expired) MUK escrow.
	 */
	hasValidEscrow(): boolean;

	/**
	 * Check if there is a valid escrow for a specific email.
	 */
	hasValidEscrowForEmail(email: string): boolean;

	/**
	 * Get remaining escrow time in milliseconds.
	 */
	getEscrowRemainingTime(): number;

	/**
	 * Clear the MUK escrow (on logout or when password required).
	 */
	clearEscrow(): boolean;

	/**
	 * Sync account KDF metadata, vault keys, and items for the unified
	 * vault-based autofill system. The native side rejects incomplete profiles.
	 */
	syncVaultData(dataJson: string): Promise<{
		vaultKeys: number;
		items: number;
		domains: number;
	}>;

	/**
	 * Get queued passkey mutations pending durable server writeback.
	 */
	getPendingPasskeyMutations(
		userId?: string,
	): Promise<PendingPasskeyMutation[]>;

	/**
	 * Mark queued passkey mutations as successfully applied remotely.
	 */
	markPendingPasskeyMutationsApplied(ids: string[]): Promise<boolean>;

	/**
	 * Mark queued passkey mutations as failed (increments attempt count).
	 */
	markPendingPasskeyMutationsFailed(
		ids: string[],
		error: string,
	): Promise<boolean>;

	// ============================================
	// 30-Day Master Password Re-entry
	// ============================================

	/**
	 * Check if master password re-entry is required (> 30 days since last entry).
	 */
	isMasterPasswordReentryRequired(): boolean;

	/**
	 * Check if biometric unlock can be used (combines escrow validity and 30-day check).
	 */
	canUseBiometricUnlock(): boolean;

	/**
	 * Update the last master password entry timestamp.
	 * Call this after successful password-based unlock.
	 */
	updateLastMasterPasswordEntry(): boolean;

	/**
	 * Get the timestamp of the last master password entry.
	 */
	getLastMasterPasswordEntry(): number;

	// ============================================
	// Credential Provider API
	// ============================================

	/**
	 * Check if the Credential Manager API is available on this device.
	 * Requires Android 14 (API 34) or higher.
	 */
	isAvailable(): boolean;

	/**
	 * Check if biometric authentication is available.
	 */
	isBiometricAvailable(): boolean;

	/**
	 * Open Android system settings for credential providers.
	 * Returns true if opened the credential provider settings,
	 * false if fell back to security settings.
	 */
	openCredentialProviderSettings(): boolean;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CredentialProviderModule>(
	"CredentialProvider",
);
