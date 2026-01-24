import { NativeModule, registerWebModule } from "expo";

import type {
	Credential,
	CredentialProviderModuleEvents,
	SaveCredentialParams,
	SyncResult,
} from "./CredentialProvider.types";

/**
 * Web implementation of CredentialProviderModule.
 * The Credential Manager API is Android-only, so all methods return
 * appropriate fallback values on web.
 */
class CredentialProviderModule extends NativeModule<CredentialProviderModuleEvents> {
	isAvailable(): boolean {
		return false;
	}

	isBiometricAvailable(): boolean {
		return false;
	}

	isKeyAvailable(): boolean {
		return false;
	}

	openCredentialProviderSettings(): boolean {
		console.warn("CredentialProvider: Not available on web");
		return false;
	}

	async initializeKey(): Promise<boolean> {
		console.warn("CredentialProvider: Not available on web");
		return false;
	}

	async saveCredential(_params: SaveCredentialParams): Promise<string> {
		console.warn("CredentialProvider: Not available on web");
		throw new Error("Credential Provider is not available on web");
	}

	async syncCredentials(
		_credentials: SaveCredentialParams[],
	): Promise<SyncResult> {
		console.warn("CredentialProvider: Not available on web");
		return { synced: 0, deleted: 0 };
	}

	async getAllCredentials(): Promise<Credential[]> {
		return [];
	}

	async getCredentialCount(): Promise<number> {
		return 0;
	}

	async deleteCredential(_id: string): Promise<boolean> {
		console.warn("CredentialProvider: Not available on web");
		return false;
	}

	async clearAllCredentials(): Promise<boolean> {
		console.warn("CredentialProvider: Not available on web");
		return false;
	}
}

export default registerWebModule(
	CredentialProviderModule,
	"CredentialProviderModule",
);
