/**
 * Parameters for escrowing the MUK with biometric protection
 */
export interface EscrowMukParams {
	/** The account email this escrow is for */
	email: string;
	/** Optional user ID for multi-account MUK storage */
	userId?: string;
	/** Optional escrow timeout in milliseconds (default 10 minutes) */
	timeoutMs?: number;
}

/**
 * Events emitted by the Credential Provider module
 */
export interface CredentialProviderModuleEvents {
	/** Fired when the vault is unlocked */
	onVaultUnlocked: (params: { success: boolean }) => void;
	/** Fired when the vault is locked */
	onVaultLocked: (params: { success: boolean }) => void;
	[key: string]: any;
}

/**
 * Deferred mutation written by the Android credential provider.
 * Flushed by the React Native sync layer before pulling inbound vault data.
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
