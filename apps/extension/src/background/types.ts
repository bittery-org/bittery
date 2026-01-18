/**
 * Shared types for background service worker messages
 */

export interface MessageResponse {
	success: boolean;
	error?: string;
	[key: string]: unknown;
}

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
