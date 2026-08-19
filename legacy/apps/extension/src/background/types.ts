/**
 * Shared types for background service worker messages
 *
 * Runtime message payloads and responses live in `router/contract.ts`; this
 * file is only for background-local shapes that never travel over the wire.
 */

export interface SessionData {
	email: string;
	userId: string;
	[key: string]: unknown;
}

export interface VaultKeyData {
	vaultId: string;
	encryptedVaultKey: string;
	[key: string]: unknown;
}
