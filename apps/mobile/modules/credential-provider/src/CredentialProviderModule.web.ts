import { NativeModule, registerWebModule } from "expo";

import type {
	Credential,
	CredentialProviderModuleEvents,
	EscrowMukParams,
	PendingPasskeyMutation,
	SaveCredentialParams,
	SyncResult,
} from "./CredentialProvider.types";

/**
 * Web implementation of CredentialProviderModule.
 * The Credential Manager API is Android-only, so all methods return
 * appropriate fallback values on web.
 */
class CredentialProviderModule extends NativeModule<CredentialProviderModuleEvents> {
	setMasterUnlockKey(_mukBase64: string, _userId?: string): boolean {
		return false;
	}

	clearMasterUnlockKey(_userId?: string): boolean {
		return false;
	}

	clearAllMasterUnlockKeys(): boolean {
		return false;
	}

	isVaultUnlocked(_userId?: string): boolean {
		return false;
	}

	getMasterUnlockKeyBase64(_userId?: string): string | null {
		return null;
	}

	escrowMukWithBiometric(_params: EscrowMukParams): Promise<boolean> {
		return Promise.resolve(false);
	}

	retrieveEscrowedMuk(): Promise<boolean> {
		return Promise.resolve(false);
	}

	hasValidEscrow(): boolean {
		return false;
	}

	hasValidEscrowForEmail(_email: string): boolean {
		return false;
	}

	getEscrowRemainingTime(): number {
		return 0;
	}

	clearEscrow(): boolean {
		return false;
	}

	isMasterPasswordReentryRequired(): boolean {
		return true;
	}

	canUseBiometricUnlock(): boolean {
		return false;
	}

	updateLastMasterPasswordEntry(): boolean {
		return false;
	}

	getLastMasterPasswordEntry(): number {
		return 0;
	}

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

	async syncVaultData(_dataJson: string): Promise<{
		vaultKeys: number;
		items: number;
		domains: number;
	}> {
		return { vaultKeys: 0, items: 0, domains: 0 };
	}

	async getPendingPasskeyMutations(
		_userId?: string,
	): Promise<PendingPasskeyMutation[]> {
		return [];
	}

	async markPendingPasskeyMutationsApplied(_ids: string[]): Promise<boolean> {
		return true;
	}

	async markPendingPasskeyMutationsFailed(
		_ids: string[],
		_error: string,
	): Promise<boolean> {
		return true;
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
