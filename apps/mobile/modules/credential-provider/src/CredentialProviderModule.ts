import { NativeModule, requireNativeModule } from "expo";

import type {
	Credential,
	CredentialProviderModuleEvents,
	SaveCredentialParams,
	SyncResult,
} from "./CredentialProvider.types";

declare class CredentialProviderModule extends NativeModule<CredentialProviderModuleEvents> {
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
