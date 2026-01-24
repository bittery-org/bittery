/**
 * Parameters for saving a single credential
 */
export interface SaveCredentialParams {
  /** The vault ID this credential belongs to */
  vaultId: string;
  /** The item ID in the vault */
  itemId: string;
  /** The domain/origin this credential is for (e.g., "example.com") */
  domain: string;
  /** The username/email for this credential */
  username: string;
  /** The password (will be encrypted with biometric-protected key) */
  password: string;
  /** Display name shown in the credential picker */
  displayName: string;
  /** Optional icon URL for display */
  iconUrl?: string;
}

/**
 * Credential metadata (no password - passwords are only decrypted during autofill)
 */
export interface Credential {
  /** Unique identifier for this credential */
  id: string;
  /** The vault ID this credential belongs to */
  vaultId: string;
  /** The item ID in the vault */
  itemId: string;
  /** The domain/origin this credential is for */
  domain: string;
  /** The username/email for this credential */
  username: string;
  /** Display name shown in the credential picker */
  displayName: string;
  /** Optional icon URL */
  iconUrl?: string;
  /** Timestamp when this credential was last used for autofill */
  lastUsedAt: number;
  /** Timestamp when this credential was last synced from the vault */
  syncedAt: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  /** Number of credentials synced/updated */
  synced: number;
  /** Number of credentials deleted (no longer in vault) */
  deleted: number;
}

/**
 * Parameters for escrowing the MUK with biometric protection
 */
export interface EscrowMukParams {
  /** The account email this escrow is for */
  email: string;
  /** Optional escrow timeout in milliseconds (default 10 minutes) */
  timeoutMs?: number;
}

/**
 * Events emitted by the Credential Provider module
 */
export interface CredentialProviderModuleEvents {
  /** Fired when a credential is saved */
  onCredentialSaved: (params: { id: string }) => void;
  /** Fired when a credential is deleted */
  onCredentialDeleted: (params: { id: string }) => void;
  /** Fired when a sync operation completes */
  onSyncComplete: (params: SyncResult) => void;
  /** Fired when the vault is unlocked */
  onVaultUnlocked: (params: { success: boolean }) => void;
  /** Fired when the vault is locked */
  onVaultLocked: (params: { success: boolean }) => void;
  [key:string]: any
}
