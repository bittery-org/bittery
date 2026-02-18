import { NativeModule, requireNativeModule } from "expo";

import type {
	Credential,
	CredentialProviderModuleEvents,
	EscrowMukParams,
	PendingPasskeyMutation,
	SaveCredentialParams,
	SyncResult,
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
	 * Clear all Master Unlock Keys (on logout or auto-lock in all-accounts mode).
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
	 * Sync vault keys and items for the unified vault-based autofill system.
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
	 * Check if the biometric key exists and is valid.
	 */
	isKeyAvailable(): boolean;

	/**
	 * Open Android system settings for credential providers.
	 * Returns true if opened the credential provider settings,
	 * false if fell back to security settings.
	 */
	openCredentialProviderSettings(): boolean;

	/**
	 * Initialize the biometric key if it doesn't exist.
	 */
	initializeKey(): Promise<boolean>;

	/**
	 * Save a single credential to the credential provider storage.
	 * Requires biometric authentication.
	 * @returns The ID of the saved credential
	 */
	saveCredential(params: SaveCredentialParams): Promise<string>;

	/**
	 * Sync multiple credentials from the main vault.
	 * This is more efficient than saving credentials one by one.
	 * Requires biometric authentication.
	 * @param credentials Array of credentials to sync
	 */
	syncCredentials(credentials: SaveCredentialParams[]): Promise<SyncResult>;

	/**
	 * Get all stored credentials (metadata only, no passwords).
	 */
	getAllCredentials(): Promise<Credential[]>;

	/**
	 * Get the count of stored credentials.
	 */
	getCredentialCount(): Promise<number>;

	/**
	 * Delete a credential by ID.
	 */
	deleteCredential(id: string): Promise<boolean>;

	/**
	 * Clear all stored credentials and delete the encryption key.
	 */
	clearAllCredentials(): Promise<boolean>;

	/**
	 * Get debug info about the credential provider state.
	 */
	getDebugInfo(): Promise<{
		sdkVersion: number;
		minRequiredSdk: number;
		isApiAvailable: boolean;
		keyExists: boolean;
		biometricCanAuthenticate: number;
		biometricSuccess: boolean;
		credentialCount: number;
		credentials: Array<{
			id: string;
			domain: string;
			username: string;
			displayName: string;
			vaultId: string;
			itemId: string;
			lastUsedAt: number;
			syncedAt: number;
		}>;
	}>;
}

// This call loads the native module object from the JSI.
export default requireNativeModule<CredentialProviderModule>(
	"CredentialProvider",
);
