/**
 * Copied, not imported, from `apps/mobile/modules/credential-provider/src/
 * CredentialProvider.types.ts`. Apps must not depend on one another, and this app is
 * replacing that one — the copy is the point, and it dies with `apps/mobile`.
 */

/** Parameters for escrowing the MUK with biometric protection. */
export interface EscrowMukParams {
	/** The account email this escrow is for */
	email: string;
	/** Optional user ID for multi-account MUK storage */
	userId?: string;
	/** Optional escrow timeout in milliseconds (default 10 minutes) */
	timeoutMs?: number;
}

/**
 * Deferred mutation written by the Android credential provider.
 * Flushed by the sync layer before pulling inbound vault data.
 */
export interface PendingPasskeyMutation {
	id: string;
	userId: string;
	vaultId: string;
	itemId: string;
	operation: "create_item" | "update_item";
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	baseVersion: number;
	encryptionVersion: number;
	encryptedByUserId: string;
	createdAt: number;
	attemptCount: number;
	lastError?: string | null;
}

/** What one `syncVaultData` pass wrote. */
export interface SyncVaultDataResult {
	vaultKeys: number;
	items: number;
	domains: number;
}

/**
 * The M2-C1 manifest-merge probe: what the platform can do, what the user chose, and
 * whether the service reached the APK. Three facts that look identical from the app
 * until a credential request arrives and nothing happens.
 */
export interface ProviderSupport {
	/** The device is API 34+, so `CredentialProviderService` exists at all. */
	supported: boolean;
	apiLevel: number;
	/** The user picked Bittery as a credential provider in system settings. */
	enabled: boolean;
	/** The package manager can see the service, i.e. the manifest merge landed. */
	serviceDeclared: boolean;
	component: string;
	/** How `enabled` was decided, or why it could not be. */
	detail: string;
}
